import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { checkedRuntimePath } from "./inner-runtime-profile.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";
import { windowsPowerShellEnvironment } from "./windows-powershell-environment.mjs";

const fail = (code, details) => {
  throw Object.assign(new Error(details ? `${code}: pid=${details.pid} workerId=${details.workerId}` : code),
    { code, ...(details ? { details } : {}) });
};
const operationFile = "codex-model-operation-state.json";
const workerMarker = ".inner-worker-owner.json";
const sessionPattern = /^\.inner-cold-session-([a-f0-9-]{36})\.json$/u;
const workerPattern = /^(?:[a-f0-9-]{36}-)?worker-[0-9]+$/u;

function readJson(target, maximum = 65536) {
  checkedRuntimePath(target, { existing: true });
  if (fs.statSync(target).size > maximum) fail("COLD_START_STATE_TOO_LARGE");
  const bytes = fs.readFileSync(target);
  if (bytes.length > maximum) fail("COLD_START_STATE_TOO_LARGE");
  try { return JSON.parse(bytes.toString("utf8")); }
  catch { fail("COLD_START_INVALID_STATE"); }
}

function durableJson(target, value, replace = false) {
  checkedRuntimePath(target);
  const pending = replace ? `${target}.pending` : target;
  const descriptor = fs.openSync(pending, "wx", 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value)}\n`);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
  if (replace) renameReplaceSync(pending, target);
  if (process.platform !== "win32") {
    const directory = fs.openSync(path.dirname(target), "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  }
}

function live(pid, details) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("COLD_START_PROCESS_ID_INVALID", details);
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    if (error.code === "EPERM" || error.code === "EACCES") return undefined;
    fail("COLD_START_PROCESS_STATE_UNKNOWN", details);
  }
}

function inspectWindowsProcesses(pid) {
  try {
    const child = windowsPowerShellEnvironment();
    const filter = pid === undefined ? "" : ` -Filter 'ProcessId = ${pid}'`;
    const boot = pid === undefined ? "$b=(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o');" : "$b=$null;";
    const command = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false);$s=[DateTime]::UtcNow.ToString('o');${boot}$p=@(Get-CimInstance Win32_Process${filter} | Select-Object ProcessId,ParentProcessId,Name,CommandLine,@{n='CreationDate';e={if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}}});[pscustomobject]@{complete=$true;bootStartedAt=$b;samplingStartedAt=$s;sampledAt=[DateTime]::UtcNow.ToString('o');processes=$p}|ConvertTo-Json -Depth 4 -Compress`;
    const result = spawnSync(child.executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
      env: child.environment, encoding: "utf8", timeout: 12000, maxBuffer: 4194304, windowsHide: true });
    if (result.error || result.status !== 0) return null;
    const observed = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
    if (observed.complete !== true || !Array.isArray(observed.processes) || observed.processes.length > 16384) return null;
    const processes = new Map();
    for (const record of observed.processes) {
      if (!Number.isSafeInteger(record?.ProcessId) || record.ProcessId < 0 || processes.has(record.ProcessId)) return null;
      processes.set(record.ProcessId, record);
    }
    return { processes, bootStartedAt: observed.bootStartedAt, samplingStartedAt: observed.samplingStartedAt,
      sampledAt: observed.sampledAt, sha256: crypto.createHash("sha256").update(result.stdout).digest("hex") };
  } catch { return null; }
}

function validBirth(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(value)
    && Number.isFinite(Date.parse(value));
}

function windowsIdentity(record) {
  return validBirth(record?.CreationDate) ? { platform: "win32", createdAt: record.CreationDate } : null;
}

function fileEvidence(target, maximum = 65536, expected) {
  checkedRuntimePath(target, { existing: true });
  const identity = stat => ({ dev: stat.dev, ino: stat.ino, size: stat.size, nlink: stat.nlink,
    birthtimeMs: stat.birthtimeMs, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
  const before = fs.statSync(target);
  if (!before.isFile() || before.nlink !== 1 || before.size > maximum) fail("COLD_START_ORIGINAL_IDENTITY_UNKNOWN");
  const bytes = fs.readFileSync(target);
  if (bytes.length !== before.size || JSON.stringify(identity(before)) !== JSON.stringify(identity(fs.statSync(target)))) {
    fail("COLD_START_RECOVERY_ORIGINAL_CHANGED");
  }
  if (expected !== undefined) {
    let current;
    try { current = JSON.parse(bytes.toString("utf8")); }
    catch { fail("COLD_START_RECOVERY_ORIGINAL_CHANGED"); }
    if (JSON.stringify(current) !== JSON.stringify(expected)) fail("COLD_START_RECOVERY_ORIGINAL_CHANGED");
  }
  return { target, maximum, ...identity(before), sha256: crypto.createHash("sha256").update(bytes).digest("hex") };
}

function previousBoot(snapshot, original, processIdentity) {
  if (!snapshot || ![snapshot.bootStartedAt, snapshot.samplingStartedAt, snapshot.sampledAt].every(validBirth)) return false;
  const bootAt = Date.parse(snapshot.bootStartedAt);
  const startedAt = Date.parse(snapshot.samplingStartedAt);
  const sampledAt = Date.parse(snapshot.sampledAt);
  const now = Date.now();
  const current = windowsIdentity(snapshot.processes.get(process.pid));
  if (bootAt > startedAt || startedAt > sampledAt || now < sampledAt || now - startedAt > 15000
    || !current || Date.parse(current.createdAt) < bootAt || Date.parse(current.createdAt) > startedAt
    || Math.abs(Date.parse(current.createdAt) - (now - process.uptime() * 1000)) > 2000) return false;
  if (![original.birthtimeMs, original.mtimeMs].every(value => Number.isFinite(value) && value > 0 && value + 2000 < bootAt)) return false;
  return processIdentity == null || (processIdentity.platform === "win32" && validBirth(processIdentity.createdAt)
    && Date.parse(processIdentity.createdAt) < bootAt && Date.parse(processIdentity.createdAt) <= original.mtimeMs + 2000);
}

function workerCommand(command) {
  if (typeof command !== "string" || !command.trim() || command.replace(/"[^"]*"|[^\s"]+|\s+/gu, "")) return "unknown";
  const tokens = command.match(/"[^"]*"|[^\s"]+/gu).map(token => token.replace(/^"|"$/gu, ""));
  tokens.shift();
  while (tokens.length) {
    const token = tokens.shift();
    if (/^--(?:inspect(?:-brk)?(?:=\S+)?|no-warnings|trace-warnings|enable-source-maps)$/u.test(token)) continue;
    if (token === "--") break;
    if (["-e", "--eval", "-p", "--print"].includes(token)) return tokens.length ? "other" : "unknown";
    if (/^--(?:eval|print)=/u.test(token)) return "other";
    if (token.startsWith("-")) return "unknown";
    return path.win32.basename(token).toLowerCase() === "codex-model-stream-proxy-runner.mjs" ? "worker" : "other";
  }
  const entry = tokens.shift();
  return entry ? (path.win32.basename(entry).toLowerCase() === "codex-model-stream-proxy-runner.mjs" ? "worker" : "other") : "unknown";
}

function checkOldWorker(marker, markerPath, inspect, recoverPreviousBoot = () => false) {
  const details = { pid: marker.pid, workerId: marker.workerId, sessionId: marker.sessionId };
  const state = live(marker.pid, details);
  if (state === false) return null;
  if (process.platform !== "win32") fail("COLD_START_OLD_WORKER_ALIVE", details);
  const observed = inspect()?.get(marker.pid);
  if (!observed) {
    const confirmed = live(marker.pid, details);
    if (confirmed === false) return null;
    if (state === undefined && confirmed === undefined && recoverPreviousBoot()) return { ...details, reason: "previous_system_boot" };
    fail("COLD_START_PROCESS_STATE_UNKNOWN", { ...details, reason: "process_snapshot_unavailable" });
  }
  const identity = windowsIdentity(observed);
  Object.assign(details, { observedProcessName: observed.Name, observedCreatedAt: identity?.createdAt,
    recordedCreatedAt: marker.processIdentity?.createdAt });
  if (marker.processIdentity != null) {
    if (marker.processIdentity.platform !== "win32" || !validBirth(marker.processIdentity.createdAt) || !identity) {
      fail("COLD_START_PROCESS_STATE_UNKNOWN", { ...details, reason: "process_birth_unavailable" });
    }
    if (marker.processIdentity.createdAt === identity.createdAt) {
      fail("COLD_START_OLD_WORKER_ALIVE", { ...details, reason: "matching_creation_time" });
    }
    return { ...details, reason: "creation_time_changed" };
  }
  if (typeof observed.Name !== "string" || !observed.Name.trim()) {
    fail("COLD_START_PROCESS_STATE_UNKNOWN", { ...details, reason: "process_name_unavailable" });
  }
  const command = workerCommand(observed.CommandLine);
  if (command === "worker") fail("COLD_START_OLD_WORKER_ALIVE", { ...details, reason: "legacy_runner_present" });
  if (!/^node(?:\.exe)?$/iu.test(observed.Name)) return { ...details, reason: "different_process_type" };
  if (command === "other") return { ...details, reason: "different_process_command" };
  if (identity && Date.parse(identity.createdAt) > fs.statSync(markerPath).mtimeMs + 2000) {
    return { ...details, reason: "created_after_marker" };
  }
  fail("COLD_START_PROCESS_STATE_UNKNOWN", { ...details, reason: "legacy_process_identity_unavailable" });
}

export function acquireInnerColdStart({ stateRoot, ownerId, nativeSourceId, sessionId }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(sessionId ?? "")
    || ![ownerId, nativeSourceId].every(value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,128}$/u.test(value))) {
    fail("COLD_START_IDENTITY_INVALID");
  }
  const root = checkedRuntimePath(stateRoot, { directory: true });
  const binding = { schemaVersion: 1, ownerId, nativeSourceId };
  const matches = record => record && record.schemaVersion === 1 && record.ownerId === ownerId
    && record.nativeSourceId === nativeSourceId;
  const rootMarker = path.join(root, ".inner-cold-root-owner.json");
  if (!fs.existsSync(rootMarker)) {
    try { durableJson(rootMarker, { ...binding, kind: "cold-start-root" }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const rootOwner = readJson(rootMarker);
  if (!matches(rootOwner) || rootOwner.kind !== "cold-start-root") fail("COLD_START_ROOT_OWNER_MISMATCH");
  const claimPath = path.join(root, `.inner-cold-session-${sessionId}.json`);
  const claim = { ...binding, kind: "session", sessionId, pid: process.pid };
  durableJson(claimPath, claim);
  const closeSession = (target, closedSessionId, recovery = {}) => {
    const closedPath = `${target}.closed`;
    const validate = () => {
      const closed = readJson(closedPath);
      if (!matches(closed) || closed.kind !== "closed" || closed.sessionId !== closedSessionId) fail("COLD_START_SESSION_CLOSE_INVALID");
    };
    try { durableJson(closedPath, { ...binding, kind: "closed", sessionId: closedSessionId, ...recovery }); }
    catch (error) { if (error.code !== "EEXIST") throw error; validate(); }
  };
  let released = false;
  const release = () => {
    if (released) return;
    closeSession(claimPath, sessionId);
    released = true;
  };
  try {
    const children = fs.readdirSync(root, { withFileTypes: true });
    if (children.length > 2048) fail("COLD_START_DISCOVERY_CAPACITY");
    if (fs.existsSync(path.join(root, operationFile))) fail("COLD_START_UNBOUND_ROOT_STATE");
    const sessions = new Map();
    const sessionPaths = new Map();
    const recoveredSessions = [];
    const recoveryFiles = new Map();
    const bootFiles = new Map();
    const workerChecks = [];
    let observed;
    const snapshot = () => (observed === undefined ? (observed = inspectWindowsProcesses()) : observed);
    const inspect = () => snapshot()?.processes;
    const track = (target, maximum, expected) => {
      const evidence = fileEvidence(target, maximum, expected);
      if (recoveryFiles.has(target) && JSON.stringify(recoveryFiles.get(target)) !== JSON.stringify(evidence)) {
        fail("COLD_START_RECOVERY_ORIGINAL_CHANGED");
      }
      recoveryFiles.set(target, evidence);
      return evidence;
    };
    const provePreviousBoot = (target, processIdentity) => {
      const evidence = track(target);
      if (!previousBoot(snapshot(), evidence, processIdentity)) return false;
      bootFiles.set(target, { evidence, processIdentity });
      return true;
    };
    const discovered = entries => entries.filter(child => sessionPattern.test(child.name) || workerPattern.test(child.name)
      || (child.isDirectory() && fs.existsSync(path.join(root, child.name, operationFile)))).map(child => child.name).sort().join("\n");
    const discovery = discovered(children);
    for (const child of children) {
      const match = sessionPattern.exec(child.name);
      if (!match) continue;
      const target = path.join(root, child.name);
      const record = readJson(target);
      if (!matches(record) || record.kind !== "session" || record.sessionId !== match[1]
        || !Number.isSafeInteger(record.pid) || record.pid < 1) fail("COLD_START_SESSION_OWNER_MISMATCH");
      sessions.set(record.sessionId, record);
      sessionPaths.set(record.sessionId, target);
      if (record.sessionId === sessionId) continue;
      if (fs.existsSync(`${target}.closed`)) {
        const closed = readJson(`${target}.closed`);
        if (!matches(closed) || closed.kind !== "closed" || closed.sessionId !== record.sessionId) fail("COLD_START_SESSION_CLOSE_INVALID");
      } else {
        const state = live(record.pid);
        if (state === false) {
          track(target, undefined, record);
          recoveredSessions.push({ target, record });
        }
        else {
          const identity = windowsIdentity(inspect()?.get(record.pid));
          if (!identity) {
            if (state === undefined && !inspect()?.has(record.pid) && provePreviousBoot(target, record.processIdentity)) {
              recoveredSessions.push({ target, record, previousBoot: true });
              continue;
            }
            fail("COLD_START_PROCESS_STATE_UNKNOWN", { pid: record.pid, sessionId: record.sessionId, reason: "process_snapshot_unavailable" });
          }
          if (Date.parse(identity.createdAt) <= fs.statSync(target).mtimeMs + 2000) fail("COLD_START_OTHER_SESSION_ALIVE");
        }
      }
    }
    const merged = new Map();
    const ignoredWorkerPids = [];
    let recoveredWorkers = 0;
    for (const child of children) {
      const target = path.join(root, child.name);
      if (!workerPattern.test(child.name) && !(child.isDirectory() && fs.existsSync(path.join(target, operationFile)))) continue;
      checkedRuntimePath(target, { directory: true });
      const markerPath = path.join(target, workerMarker);
      if (!fs.existsSync(markerPath)) fail("COLD_START_WORKER_UNOWNED");
      const marker = readJson(markerPath);
      if (!matches(marker) || marker.kind !== "worker" || marker.workerId !== child.name
        || !sessions.has(marker.sessionId) || !child.name.startsWith(`${marker.sessionId}-worker-`)) fail("COLD_START_WORKER_OWNER_MISMATCH");
      if (marker.sessionId === sessionId) continue;
      if (marker.phase !== "started") fail("COLD_START_WORKER_START_UNRESOLVED");
      const recoverPreviousBoot = () => provePreviousBoot(sessionPaths.get(marker.sessionId), sessions.get(marker.sessionId).processIdentity)
        && provePreviousBoot(markerPath, marker.processIdentity);
      const closingSession = recoveredSessions.find(session => session.record.sessionId === marker.sessionId);
      if (closingSession?.previousBoot && !recoverPreviousBoot()) fail("COLD_START_PROCESS_STATE_UNKNOWN", {
        pid: marker.pid, workerId: marker.workerId, sessionId: marker.sessionId, reason: "worker_boot_identity_unavailable" });
      const ignored = checkOldWorker(marker, markerPath, inspect, recoverPreviousBoot);
      if (ignored) ignoredWorkerPids.push(ignored);
      const statePath = path.join(target, operationFile);
      if (!fs.existsSync(statePath)) fail("COLD_START_LEDGER_MISSING");
      const originalState = readJson(statePath, 2 * 1024 * 1024);
      if (closingSession || ignored?.reason === "previous_system_boot") {
        track(markerPath, undefined, marker);
        track(statePath, 2 * 1024 * 1024, originalState);
        workerChecks.push({ marker, markerPath, previousBoot: bootFiles.has(markerPath) });
      }
      const restored = createModelOperationLedger({ state: originalState }).snapshot();
      for (const [key, entry] of restored.entries) {
        if (!entry.threadHash) fail("COLD_START_OPERATION_UNBOUND");
        const previous = merged.get(key);
        if (previous && previous.threadHash !== entry.threadHash) fail("COLD_START_OPERATION_CONFLICT");
        merged.set(key, { ...entry, acceptance: previous?.acceptance === "accepted" ? "accepted" : entry.acceptance });
        if (merged.size > 2048) fail("COLD_START_LEDGER_CAPACITY");
      }
      recoveredWorkers += 1;
    }
    const recovered = createModelOperationLedger({ state: { schemaVersion: 1, entries: [...merged] } }).snapshot();
    let finalSnapshot;
    if (bootFiles.size) {
      finalSnapshot = inspectWindowsProcesses();
      for (const { evidence, processIdentity } of bootFiles.values()) {
        if (!previousBoot(finalSnapshot, evidence, processIdentity) || finalSnapshot.bootStartedAt !== snapshot().bootStartedAt) {
          fail("COLD_START_PROCESS_STATE_UNKNOWN", { reason: "system_boot_evidence_changed" });
        }
      }
    }
    for (const { marker, markerPath, previousBoot: endedBeforeBoot } of workerChecks) {
      checkOldWorker(marker, markerPath, () => (finalSnapshot ??= inspectWindowsProcesses())?.processes,
        () => endedBeforeBoot && !finalSnapshot?.processes.has(marker.pid));
    }
    if (recoveryFiles.size && discovery !== discovered(fs.readdirSync(root, { withFileTypes: true }))) fail("COLD_START_DISCOVERY_CHANGED");
    for (const evidence of recoveryFiles.values()) {
      if (JSON.stringify(fileEvidence(evidence.target, evidence.maximum)) !== JSON.stringify(evidence)) fail("COLD_START_RECOVERY_ORIGINAL_CHANGED");
    }
    for (const { target, record } of recoveredSessions) {
      if (JSON.stringify(readJson(target)) !== JSON.stringify(record)) fail("COLD_START_SESSION_CHANGED");
      const state = live(record.pid);
      const endedBeforeBoot = bootFiles.has(target) && state === undefined && !finalSnapshot?.processes.has(record.pid);
      if (state !== false && !endedBeforeBoot) fail("COLD_START_PROCESS_STATE_UNKNOWN", {
        pid: record.pid, sessionId: record.sessionId, reason: "session_recovery_evidence_changed" });
      const originals = [...recoveryFiles.values()].filter(evidence => evidence.target === target
        || path.basename(path.dirname(evidence.target)).startsWith(`${record.sessionId}-worker-`))
        .map(evidence => ({ name: path.relative(root, evidence.target), sha256: evidence.sha256,
          birthtimeMs: evidence.birthtimeMs, mtimeMs: evidence.mtimeMs })).sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
      closeSession(target, record.sessionId, { reason: endedBeforeBoot ? "verified_previous_boot_session_recovered" : "verified_dead_session_recovered",
        recoveredBySessionId: sessionId, ...(endedBeforeBoot ? { recoveryEvidence: {
          source: "Win32_OperatingSystem.LastBootUpTime", bootStartedAt: finalSnapshot.bootStartedAt,
          firstSampledAt: snapshot().sampledAt, finalSampledAt: finalSnapshot.sampledAt,
          firstSnapshotSha256: snapshot().sha256, finalSnapshotSha256: finalSnapshot.sha256,
          originalCount: originals.length, originalsSha256: crypto.createHash("sha256").update(JSON.stringify(originals)).digest("hex"),
        } } : {}) });
    }
    return {
      status: { recoveredWorkers, protectedOperations: recovered.entries.length, sessionId, ignoredWorkerPids },
      seed(workerRoot, workerId) {
        if (released || path.dirname(workerRoot) !== root || !workerId.startsWith(`${sessionId}-worker-`)) fail("COLD_START_SEED_TARGET_INVALID");
        checkedRuntimePath(workerRoot);
        if (!fs.existsSync(workerRoot)) fs.mkdirSync(workerRoot);
        durableJson(path.join(workerRoot, workerMarker), { ...binding, kind: "worker", sessionId, workerId, phase: "prepared", pid: null });
        durableJson(path.join(workerRoot, operationFile), recovered);
      },
      started(workerRoot, workerId, pid) {
        if (released || path.dirname(workerRoot) !== root || !workerId.startsWith(`${sessionId}-worker-`)
          || !Number.isSafeInteger(pid) || pid < 1) fail("COLD_START_WORKER_IDENTITY_INVALID");
        const observed = process.platform === "win32" && live(pid) !== false ? inspectWindowsProcesses(pid)?.processes.get(pid) : null;
        const processIdentity = observed?.ParentProcessId === process.pid ? windowsIdentity(observed) : null;
        durableJson(path.join(workerRoot, workerMarker), { ...binding, kind: "worker", sessionId, workerId,
          phase: "started", pid, ...(process.platform === "win32" ? { processIdentity } : {}) }, true);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
