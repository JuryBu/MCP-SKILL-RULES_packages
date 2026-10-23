import fs from "node:fs";
import path from "node:path";
import { checkedRuntimePath } from "./inner-runtime-profile.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
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

function live(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) fail("COLD_START_PROCESS_ID_INVALID");
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") return false;
    fail("COLD_START_PROCESS_STATE_UNKNOWN");
  }
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
  let released = false;
  const release = () => {
    if (released) return;
    durableJson(`${claimPath}.closed`, { ...binding, kind: "closed", sessionId });
    released = true;
  };
  try {
    const children = fs.readdirSync(root, { withFileTypes: true });
    if (children.length > 2048) fail("COLD_START_DISCOVERY_CAPACITY");
    if (fs.existsSync(path.join(root, operationFile))) fail("COLD_START_UNBOUND_ROOT_STATE");
    const sessions = new Map();
    for (const child of children) {
      const match = sessionPattern.exec(child.name);
      if (!match) continue;
      const target = path.join(root, child.name);
      const record = readJson(target);
      if (!matches(record) || record.kind !== "session" || record.sessionId !== match[1]
        || !Number.isSafeInteger(record.pid) || record.pid < 1) fail("COLD_START_SESSION_OWNER_MISMATCH");
      sessions.set(record.sessionId, record);
      if (record.sessionId === sessionId) continue;
      if (fs.existsSync(`${target}.closed`)) {
        const closed = readJson(`${target}.closed`);
        if (!matches(closed) || closed.kind !== "closed" || closed.sessionId !== record.sessionId) fail("COLD_START_SESSION_CLOSE_INVALID");
      } else if (live(record.pid)) fail("COLD_START_OTHER_SESSION_ALIVE");
    }
    const merged = new Map();
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
      if (live(marker.pid)) fail("COLD_START_OLD_WORKER_ALIVE");
      const statePath = path.join(target, operationFile);
      if (!fs.existsSync(statePath)) fail("COLD_START_LEDGER_MISSING");
      const restored = createModelOperationLedger({ state: readJson(statePath, 2 * 1024 * 1024) }).snapshot();
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
    return {
      status: { recoveredWorkers, protectedOperations: recovered.entries.length, sessionId },
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
        durableJson(path.join(workerRoot, workerMarker), { ...binding, kind: "worker", sessionId, workerId, phase: "started", pid }, true);
      },
      release,
    };
  } catch (error) {
    release();
    throw error;
  }
}
