import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { checkedRuntimePath } from "./inner-runtime-profile.mjs";
import { createModelOperationLedger } from "./model-operation-ledger.mjs";
import { validateDurableRecoveryState } from "./thread-recovery-handoff.mjs";
import { renameReplaceSync } from "./atomic-file.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const read = file => {
  checkedRuntimePath(file, { existing: true });
  if (fs.statSync(file).size > 2 * 1024 * 1024) fail("WORKER_RECOVERY_STATE_TOO_LARGE");
  const bytes = fs.readFileSync(file);
  if (bytes.length > 2 * 1024 * 1024) fail("WORKER_RECOVERY_STATE_TOO_LARGE");
  return JSON.parse(bytes.toString("utf8"));
};
function write(file, state) {
  checkedRuntimePath(file);
  const pending = `${file}.${crypto.randomUUID()}.pending`;
  const descriptor = fs.openSync(pending, "wx", 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(state)); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  try { renameReplaceSync(pending, file); }
  finally { if (fs.existsSync(pending)) fs.unlinkSync(pending); }
}

export function readFailedWorkerRecovery({ root, worker, ownerId, nativeSourceId, sessionId, threadIds }) {
  if (worker.child.exitCode === null && worker.child.signalCode === null) fail("WORKER_RECOVERY_SOURCE_ALIVE");
  const stateRoot = checkedRuntimePath(worker.stateRoot, { directory: true });
  if (path.dirname(stateRoot) !== fs.realpathSync(root) || path.basename(stateRoot) !== worker.workerId) fail("WORKER_RECOVERY_SOURCE_ESCAPE");
  const marker = read(path.join(stateRoot, ".inner-worker-owner.json"));
  if (marker.schemaVersion !== 1 || marker.kind !== "worker" || marker.phase !== "started"
    || marker.ownerId !== ownerId || marker.nativeSourceId !== nativeSourceId || marker.sessionId !== sessionId
    || marker.workerId !== worker.workerId || marker.pid !== worker.child.pid) fail("WORKER_RECOVERY_OWNER_MISMATCH");
  const ids = new Set(threadIds);
  const hashes = new Set(threadIds.map(hash));
  const operationState = createModelOperationLedger({ state: read(path.join(stateRoot, "codex-model-operation-state.json")) }).snapshot();
  if (operationState.entries.some(([_key, entry]) => !entry.threadHash)) fail("WORKER_RECOVERY_OPERATION_UNBOUND");
  operationState.entries = operationState.entries.filter(([_key, entry]) => hashes.has(entry.threadHash));
  const recoveryState = validateDurableRecoveryState(read(path.join(stateRoot, "codex-model-recovery-state.json")));
  for (const entries of Object.values(recoveryState.state)) {
    entries.splice(0, entries.length, ...entries.filter(([key]) => ids.has(key.split("\u0000")[0])));
  }
  return { operationState, recoveryState };
}

export function readRecoveredWorkerOperation(worker, metadata, request) {
  if (!worker.recoveredFrom) return null;
  const pathname = String(request.url ?? "").split("?")[0].replace(/\/+$/u, "");
  const fallbackKind = request.method === "POST" && /\/responses(?:\/compact)?$/u.test(pathname)
    ? (pathname.endsWith("/compact") ? "compaction" : "turn") : null;
  const requestKind = typeof metadata?.request_kind === "string" ? metadata.request_kind : fallbackKind;
  if (!["turn", "compaction"].includes(requestKind) || !metadata?.thread_id || !metadata?.turn_id) return null;
  const operations = createModelOperationLedger({ state: read(path.join(worker.stateRoot, "codex-model-operation-state.json")) });
  const entry = operations.get(`${metadata.thread_id}\u0000${metadata.turn_id}\u0000${requestKind}`);
  return entry ? { requestKind, entry } : null;
}

export function seedFailedWorkerRecovery(stateRoot, seed) {
  const operationFile = path.join(stateRoot, "codex-model-operation-state.json");
  const combined = createModelOperationLedger({ state: read(operationFile) });
  const entries = new Map(combined.snapshot().entries);
  for (const [key, entry] of seed.operationState.entries) {
    const previous = entries.get(key);
    if (previous && previous.threadHash !== entry.threadHash) fail("WORKER_RECOVERY_OPERATION_CONFLICT");
    entries.set(key, { ...entry, acceptance: previous?.acceptance === "accepted" ? "accepted" : entry.acceptance });
  }
  write(operationFile, createModelOperationLedger({ state: { schemaVersion: 1, entries: [...entries] } }).snapshot());
  write(path.join(stateRoot, "codex-model-recovery-state.json"), validateDurableRecoveryState(seed.recoveryState));
}

export function writeWorkerRecoveryCheckpoint({ root, ownerId, capability, worker, threadId, native, plan, seed }) {
  const operations = createModelOperationLedger({ state: seed.operationState });
  const ledgerEnabled = JSON.parse(seed.recoveryState.policyKey).operationLedgerSchema === 1;
  if (!ledgerEnabled && seed.operationState.entries.length) fail("WORKER_RECOVERY_LEDGER_UNSUPPORTED");
  const snapshot = { schemaVersion: 1, threadId, token: crypto.randomUUID(), capturedAt: Date.now(),
    policyKey: seed.recoveryState.policyKey,
    state: Object.fromEntries(Object.entries(seed.recoveryState.state)
      .map(([channel, entries]) => [channel, entries.filter(([key]) => key.split("\u0000")[0] === threadId)])),
    ...(ledgerEnabled ? { operationState: operations.exportThread(threadId) } : {}) };
  const live = native.phase === "active";
  const payload = { schemaVersion: 1, ownerId,
    source: { pid: worker.child.pid, instanceToken: worker.ready.instanceToken, sourceHashes: worker.ready.sourceHashes },
    ...(live ? { live: true, native } : { terminal: native }), snapshot,
    snapshotSha256: hash(JSON.stringify(snapshot)), migrationPlanSha256: hash(JSON.stringify(plan)),
    ...(plan.compatibility ? { compatibilityManifestSha256: plan.compatibility.sha256 } : {}) };
  const envelope = { payload, signature: crypto.createHmac("sha256", Buffer.from(capability, "hex")).update(JSON.stringify(payload)).digest("hex") };
  const fileName = `inner-runner-recovery-${plan.id}.json`;
  const filePath = path.join(root, fileName);
  if (fs.existsSync(filePath)) fail("WORKER_RECOVERY_CHECKPOINT_EXISTS");
  if (Buffer.byteLength(JSON.stringify(envelope)) > 1024 * 1024 + 16 * 1024) fail("WORKER_RECOVERY_STATE_TOO_LARGE");
  write(filePath, envelope);
  return { fileName, sha256: hash(fs.readFileSync(filePath)), threadId, sourceInstanceToken: worker.ready.instanceToken, live };
}
