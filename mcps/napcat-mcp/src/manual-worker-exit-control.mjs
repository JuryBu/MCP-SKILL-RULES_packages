import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const controls = Symbol.for("napcat.manual-worker-exit.v1");
const validId = value => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,179}$/u.test(value);
const validCommandId = value => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
const alive = worker => worker?.child?.exitCode === null && worker.child.signalCode === null;
const fail = code => { throw Object.assign(new Error(code), { code }); };

function targetView(state, worker) {
  const threads = [...state.threads.values(), ...state.terminalThreads.values()];
  const owned = threads.filter(thread => thread.worker === worker);
  const references = threads.filter(thread => thread.pendingActivation?.source === worker || thread.pendingActivation?.target === worker);
  const warnings = [];
  if (state.defaultWorker === worker) warnings.push("CURRENT_DEFAULT_WILL_BE_UNAVAILABLE");
  if (state.activation?.source === worker) warnings.push("LIVE_ROLLBACK_SOURCE_WILL_BE_UNAVAILABLE");
  if (state.activation?.target === worker) warnings.push("ACTIVATION_TARGET");
  if (owned.length || worker.threadHistory?.size) warnings.push("RETAINED_THREAD_OWNERSHIP");
  if (references.length) warnings.push("PENDING_THREAD_MIGRATION");
  if (worker.activeHttp || owned.some(thread => thread.activeHttp || thread.nativeRelays)) warnings.push("ACTIVE_REQUESTS_WILL_BE_INTERRUPTED");
  if ([...state.pending.values()].some(request => request.worker === worker)) warnings.push("PENDING_CONTROL_REQUESTS");
  if (state.transactionActive || state.preparationTask || state.workerMaintenance) warnings.push("CONCURRENT_MANAGEMENT_OPERATION");
  if (worker.recoveryTask) warnings.push("WORKER_RECOVERY_IN_PROGRESS");
  return { sessionId: state.sessionId, workerId: worker.workerId, pid: worker.child.pid,
    instanceToken: worker.ready?.instanceToken ?? null, alive: alive(worker),
    isDefault: state.defaultWorker === worker, warnings,
    affectedThreadIds: [...new Set(owned.map(thread => thread.threadId))],
    retainedHistoryCount: worker.threadHistory?.size ?? 0, replacementWorkerId: worker.replacementWorker?.workerId ?? null,
    dataPolicy: "preserve_history_checkpoints_and_ledgers", automaticRestart: false };
}

function storeFor(state) {
  if (!state[controls]) Object.defineProperty(state, controls, { value: { commands: new Map() } });
  return state[controls];
}

function saveReceipt(state, receipt) {
  const directory = path.join(state.root, "manual-worker-exit-receipts");
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, `${receipt.commandId}.json`);
  const temporary = `${destination}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(temporary, destination);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function storedReceipt(state, commandId) {
  const destination = path.join(state.root, "manual-worker-exit-receipts", `${commandId}.json`);
  try { return JSON.parse(fs.readFileSync(destination, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function fingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify({ instanceId: input.instanceId, sessionId: input.sessionId,
    workerId: input.workerId, pid: input.pid, mode: input.mode, confirmation: input.confirmation })).digest("hex");
}

async function cleanupPreparations(wholeRuntime, instanceId, receipt) {
  if (!wholeRuntime?.liveCodeParticipant || receipt.state !== "exited") return;
  const whole = wholeRuntime.liveCodeParticipant().snapshot().state;
  receipt.discardedPreparations ??= [];
  receipt.preparationCleanupPending = [];
  for (const [preparationId, preparation] of whole.preparations) {
    if (preparation.workerId !== receipt.workerId) continue;
    try {
      await whole.parent.discard({ instanceId, expectedRevision: whole.parent.status().revision, preparationId });
      if (whole.preparations.get(preparationId) === preparation) whole.preparations.delete(preparationId);
      if (!receipt.discardedPreparations.includes(preparationId)) receipt.discardedPreparations.push(preparationId);
    } catch (error) {
      receipt.preparationCleanupPending.push({ preparationId, code: error.code ?? "MANUAL_WORKER_PREPARATION_CLEANUP_PENDING" });
    }
  }
}

async function waitForExit(worker, milliseconds) {
  if (!alive(worker)) return true;
  let timer;
  let exited;
  try {
    return await Promise.race([new Promise(resolve => { exited = () => resolve(true); worker.child.once("exit", exited); }),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]);
  } finally {
    clearTimeout(timer);
    worker.child.removeListener("exit", exited);
  }
}

export async function manualWorkerExitControl({ coordinator, wholeRuntime, instanceId, input, shutdownWaitMs = 15000 }) {
  if (!coordinator?.liveCodeParticipant || typeof instanceId !== "string") fail("MANUAL_WORKER_CONTROL_UNAVAILABLE");
  const state = coordinator.liveCodeParticipant().snapshot().state;
  if (!state?.workers || typeof state.sessionId !== "string" || !state.root) fail("MANUAL_WORKER_STATE_UNAVAILABLE");
  if (input?.instanceId !== instanceId) fail("MANUAL_WORKER_INSTANCE_MISMATCH");
  if (input.action === "list") return { instanceId, sessionId: state.sessionId,
    defaultWorkerId: state.defaultWorker?.workerId ?? null, workers: [...state.workers.values()].map(worker => targetView(state, worker)) };
  if (input.sessionId !== state.sessionId) fail("MANUAL_WORKER_INSTANCE_MISMATCH");
  if (["status", "cleanup"].includes(input.action)) {
    if (!validCommandId(input.commandId)) fail("MANUAL_WORKER_COMMAND_ID_INVALID");
    const entry = storeFor(state).commands.get(input.commandId);
    const receipt = entry?.receipt ?? storedReceipt(state, input.commandId);
    if (!receipt) return { commandId: input.commandId, state: "not_found" };
    if (input.action === "cleanup") {
      if (entry?.cleanupTask) await entry.cleanupTask;
      await cleanupPreparations(wholeRuntime, instanceId, receipt);
      if (receipt.state === "exited") receipt.cleanupState = receipt.preparationCleanupPending?.length ? "pending" : "complete";
      saveReceipt(state, receipt);
    }
    return { ...receipt };
  }
  if (!["inspect", "exit"].includes(input.action) || !validId(input.workerId) || !Number.isSafeInteger(input.pid) || input.pid <= 4) {
    fail("MANUAL_WORKER_TARGET_INVALID");
  }
  if (input.action === "exit") {
    if (!validCommandId(input.commandId)) fail("MANUAL_WORKER_COMMAND_ID_INVALID");
    const existing = storeFor(state).commands.get(input.commandId);
    const retained = existing?.receipt ?? storedReceipt(state, input.commandId);
    if (retained) {
      if (retained.fingerprint !== fingerprint(input)) fail("MANUAL_WORKER_COMMAND_CONFLICT");
      if (existing?.cleanupTask) await existing.cleanupTask;
      return { ...retained, repeated: true };
    }
  }
  const worker = state.workers.get(input.workerId);
  if (!worker || worker.child.pid !== input.pid) fail("MANUAL_WORKER_TARGET_CHANGED");
  const view = targetView(state, worker);
  const confirmation = `${input.mode === "force" ? "FORCE EXIT" : "EXIT"} ${instanceId} ${state.sessionId} ${worker.workerId} ${worker.child.pid}`;
  if (input.action === "inspect") return { ...view, confirmation,
    forceConfirmation: `FORCE EXIT ${instanceId} ${state.sessionId} ${worker.workerId} ${worker.child.pid}` };
  if (!["graceful", "force"].includes(input.mode) || input.confirmation !== confirmation) fail("MANUAL_WORKER_CONFIRMATION_REQUIRED");
  const receipt = { schemaVersion: 1, commandId: input.commandId, fingerprint: fingerprint(input),
    instanceId, ...view, mode: input.mode, state: "accepted", requestedAt: new Date().toISOString(),
    signalDispatched: false, outcome: null };
  const entry = { receipt };
  if (view.warnings.length && input.mode !== "force") {
    receipt.state = "force_confirmation_required";
    saveReceipt(state, receipt);
    return { ...receipt };
  }
  const persistOutcome = () => {
    try { saveReceipt(state, receipt); }
    catch (error) { receipt.persistenceErrorCode = error.code ?? "MANUAL_WORKER_RECEIPT_PERSISTENCE_FAILED"; }
  };
  const completeCleanup = () => {
    if (entry.cleanupTask) return entry.cleanupTask;
    receipt.cleanupState = "running";
    persistOutcome();
    entry.cleanupTask = Promise.resolve().then(() => cleanupPreparations(wholeRuntime, instanceId, receipt))
      .then(() => { receipt.cleanupState = receipt.preparationCleanupPending?.length ? "pending" : "complete"; })
      .catch(error => { receipt.cleanupState = "pending"; receipt.preparationCleanupErrorCode = error.code ?? "MANUAL_WORKER_PREPARATION_CLEANUP_PENDING"; })
      .finally(() => {
        persistOutcome();
        if (!receipt.persistenceErrorCode) storeFor(state).commands.delete(input.commandId);
      });
    return entry.cleanupTask;
  };
  const finish = () => {
    if (alive(worker)) return false;
    if (receipt.state === "exited") return true;
    const affected = [...state.threads.values(), ...state.terminalThreads.values()];
    receipt.invalidatedAdoptions = [];
    for (const thread of affected) {
      if (thread.worker !== worker && thread.pendingActivation?.target !== worker) continue;
      if (thread.pendingActivation) receipt.invalidatedAdoptions.push(thread.threadId);
      delete thread.pendingActivation;
      thread.manualExitCommandId = input.commandId;
    }
    if (state.activation?.target === worker) state.activation.active = false;
    receipt.state = "exited";
    receipt.outcome = { exitCode: worker.child.exitCode, signalCode: worker.child.signalCode };
    receipt.finishedAt = new Date().toISOString();
    receipt.alive = false;
    persistOutcome();
    try {
      state.onEvent?.({ type: "manual_worker_exited", commandId: input.commandId, workerId: worker.workerId,
        pid: worker.child.pid, mode: input.mode, exitCode: worker.child.exitCode, signalCode: worker.child.signalCode });
    } catch (error) { receipt.eventErrorCode = error.code ?? "MANUAL_WORKER_EVENT_PERSISTENCE_FAILED"; }
    completeCleanup();
    return true;
  };
  receipt.state = "stopping";
  saveReceipt(state, receipt);
  storeFor(state).commands.set(input.commandId, entry);
  worker.reclamation = "stopping";
  worker.manualExitCommandId = input.commandId;
  if (!finish()) worker.child.once("exit", finish);
  if (alive(worker) && input.mode === "force") {
    receipt.signalDispatched = null;
    persistOutcome();
    try { receipt.signalDispatched = worker.child.kill("SIGTERM"); }
    catch (error) { receipt.signalErrorCode = error.code ?? "MANUAL_WORKER_SIGNAL_FAILED"; }
    persistOutcome();
  } else if (alive(worker)) {
    receipt.signalDispatched = true;
    persistOutcome();
    entry.shutdown = Promise.resolve().then(() => state.dispatch("control", worker, "shutdown"));
    entry.shutdown.catch(error => { receipt.shutdownCode = error.code ?? "MANUAL_WORKER_SHUTDOWN_FAILED"; persistOutcome(); });
  }
  await waitForExit(worker, shutdownWaitMs);
  if (!finish()) {
    receipt.state = input.mode === "force" ? "exit_pending" : "awaiting_force_confirmation";
    persistOutcome();
  }
  if (receipt.state === "exited") await completeCleanup();
  persistOutcome();
  return { ...receipt };
}
