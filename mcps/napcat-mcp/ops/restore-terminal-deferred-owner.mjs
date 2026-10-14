import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { inspectOwnerInput, executeOwnerAcceptance } from "./verify-full-runtime-owner.mjs";

const fail = message => { throw new Error(message); };
const hash = value => crypto.createHash("sha256").update(value).digest("hex");
const read = filename => JSON.parse(fs.readFileSync(filename, "utf8"));
export function checkTerminalDeferred(status, activation, identity) {
  const current = status.coordinator;
  if (!current || status.ownerId !== identity.ownerId || status.nativeSourceId !== identity.nativeSourceId
    || status.instanceToken !== identity.instanceId || status.busy || !current.running || !current.nativeHealthy
    || current.transactionActive || current.workerMaintenance || current.pendingControl !== 0) fail("RECOVERY_INNER_NOT_READY");
  const selected = current.activation;
  if (!selected?.active || selected.activationId !== activation.activationId
    || selected.sourceWorkerId !== activation.sourceWorkerId || selected.targetWorkerId !== activation.targetWorkerId
    || status.selectedWorkerId !== selected.targetWorkerId || current.defaultWorkerId !== selected.targetWorkerId) fail("RECOVERY_ACTIVATION_CHANGED");
  if (!Array.isArray(selected.deferredThreadIds) || !selected.deferredThreadIds.length
    || new Set(selected.deferredThreadIds).size !== selected.deferredThreadIds.length) fail("RECOVERY_PENDING_INVALID");
  for (const threadId of selected.deferredThreadIds) {
    const matches = current.threads.filter(thread => thread.threadId === threadId);
    if (!activation.deferredThreadIds.includes(threadId) || matches.length !== 1) fail("RECOVERY_THREAD_IDENTITY_CHANGED");
    const thread = matches[0];
    if (thread.phase !== "terminal" || thread.activeHttp !== 0 || thread.activationError
      || thread.pendingActivationId !== selected.activationId || thread.workerId !== selected.sourceWorkerId) fail("RECOVERY_PENDING_THREAD_NOT_TERMINAL");
  }
  if (current.threads.some(thread => thread.pendingActivationId && !selected.deferredThreadIds.includes(thread.threadId))) fail("RECOVERY_EXTRA_PENDING_THREAD");
  const source = current.workers.find(worker => worker.workerId === selected.sourceWorkerId);
  const target = current.workers.find(worker => worker.workerId === selected.targetWorkerId);
  if (!source?.alive || !source.ready || source.cleanupPending || !target?.alive || !target.ready || target.cleanupPending) fail("RECOVERY_WORKER_UNAVAILABLE");
  if (["runner", "core", "helper", "control"].some(key => !/^[a-f0-9]{64}$/.test(source.sourceHashes?.[key] ?? "")
    || source.sourceHashes[key] !== target.sourceHashes?.[key]
    || source.sourceHashes[key] !== status.selectedSourceHashes?.[key])) fail("RECOVERY_SAME_SOURCE_REQUIRED");
  return selected;
}

export async function restoreTerminalDeferred(inputPath, inputSha256, confirm, emit = console.log) {
  const context = await inspectOwnerInput(inputPath, inputSha256, true);
  const { input, status: fullBefore, verifyInstance } = context;
  const profilePin = input.pins.find(pin => path.resolve(pin.path).toLowerCase() === path.resolve(input.profilePath).toLowerCase());
  if (!profilePin || hash(fs.readFileSync(input.profilePath)) !== profilePin.sha256) fail("RECOVERY_PROFILE_CHANGED");
  const profile = read(input.profilePath);
  const eventPath = path.join(path.dirname(inputPath), "acceptance-events.jsonl");
  const records = fs.readFileSync(eventPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
  if (records.some(record => record.inputSha256 !== inputSha256)) fail("RECOVERY_EVENT_IDENTITY_CHANGED");
  const activated = records.filter(record => record.phase === "activated_snapshot");
  const failures = records.filter(record => record.phase === "failed_preserved" && record.value?.phase === "restore"
    && record.value?.error === "COORDINATOR_ACTIVATION_BUSY");
  const candidates = records.filter(record => record.phase === "candidate");
  if (activated.length !== 1 || !failures.length || candidates.length !== 1 || fullBefore.revision !== 1
    || fullBefore.selected?.manifestSha256 !== candidates[0].value.manifestSha256) fail("RECOVERY_ATTEMPT_CHANGED");
  const activation = activated[0].value.managed.coordinator.activation;
  const identity = { ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, instanceId: input.instanceId };
  const token = fs.readFileSync(input.tokenPath, "utf8").trim();
  const request = async (method, body) => {
    const response = await fetch(`${input.controlUrl}/v1/inner/${method}`, {
      method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
        "x-inner-owner-id": profile.ownerId, "x-inner-native-source-id": profile.nativeSourceId, "x-inner-instance-token": input.instanceId },
      ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal: AbortSignal.timeout(15000),
    });
    const value = await response.json();
    if (!response.ok || value.ok !== true) fail(value.error?.code ?? "RECOVERY_INNER_HTTP_FAILED");
    return value;
  };
  const before = await request("status");
  checkTerminalDeferred(before, activation, identity);
  emit("Keep Codex OPEN. This restores the current test selection without stopping services or deleting conversation history.");
  if (await confirm("Type RECOVER-TERMINAL-DEFERRED: ") !== "RECOVER-TERMINAL-DEFERRED") fail("OWNER_CANCELLED");
  verifyInstance();
  const current = await request("status");
  checkTerminalDeferred(current, activation, identity);
  const fullCurrent = await context.request();
  if (fullCurrent.revision !== 1 || fullCurrent.selected?.manifestSha256 !== fullBefore.selected.manifestSha256
    || fullCurrent.busy || fullCurrent.failed) fail("RECOVERY_FULL_SELECTION_CHANGED");
  const outputPath = path.join(path.dirname(inputPath), "terminal-deferred-recovery.jsonl");
  const append = (phase, value) => fs.appendFileSync(outputPath, JSON.stringify({ at: new Date().toISOString(), inputSha256, phase, value }) + "\n");
  fs.writeFileSync(outputPath, JSON.stringify({ phase: "started", at: new Date().toISOString(), inputSha256, current, fullCurrent }) + "\n", { flag: "wx" });
  try {
    const body = { ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, instanceToken: input.instanceId,
      requestId: "terminal-recovery-" + crypto.randomUUID(), expectedRevision: current.revision,
      selectedWorkerId: current.selectedWorkerId, selectedSourceHashes: current.selectedSourceHashes,
      activationId: activation.activationId };
    append("rollback_requested", body);
    const rolledBack = await request("rollback", body);
    append("rollback_returned", rolledBack);
    const after = await request("status");
    append("after_rollback", after);
    if (after.selectedWorkerId !== activation.sourceWorkerId || after.coordinator.activation?.active
      || after.coordinator.threads.some(thread => thread.pendingActivationId === activation.activationId)) fail("RECOVERY_ROLLBACK_NOT_CONFIRMED");
    for (const thread of current.coordinator.threads) {
      const preserved = after.coordinator.threads.find(item => item.threadId === thread.threadId);
      if (!preserved || preserved.workerId !== thread.workerId) fail("RECOVERY_THREAD_OWNERSHIP_CHANGED");
    }
    const restored = await executeOwnerAcceptance(inputPath, inputSha256, "Restore", async () => "RESTORE-SAME-RUNTIME", emit);
    append("full_restored", restored);
    return { ...restored, recovery: "TERMINAL_DEFERRED_SELECTION_RECOVERED", outputPath, servicesStopped: 0, filesReplaced: 0 };
  } catch (error) {
    append("failed_preserved", { error: error.message });
    emit(JSON.stringify({ status: "FAILED_PRESERVED", error: error.message, outputPath, retryAllowed: false }));
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  try { console.log(JSON.stringify(await restoreTerminalDeferred(process.argv[2], process.argv[3], prompt => terminal.question(prompt)))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  finally { terminal.close(); }
}
