import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planInnerStartupRecovery, applyInnerStartupRecovery } from "../src/inner-startup-residual-recovery.mjs";
import { readInnerRuntimeProfile } from "../src/inner-runtime-profile.mjs";
import { createWakeJournal } from "../src/codex-app-server-proxy.mjs";

const emptyHost = () => ({ complete: true, processes: [], listeners: [] });

test("dead busy snapshots retain in-flight counts, deferred threads and UNKNOWN history without replay", { timeout: 60000, skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-interrupted-owned-"));
  try {
    const generated = spawnSync(process.execPath, [fileURLToPath(new URL("./inner-startup-residual-native.mjs", import.meta.url)), root, "history"],
      { encoding: "utf8", windowsHide: true, timeout: 25000 });
    assert.equal(generated.status, 0, generated.stderr);
    const input = { ...JSON.parse(fs.readFileSync(path.join(root, "native-evidence.json"))), historyPolicy: "preserve", allowInterruptedSnapshot: true };
    const profile = readInnerRuntimeProfile(input.profilePath);
    const managed = JSON.parse(fs.readFileSync(profile.managedStatePath));
    const outer = JSON.parse(fs.readFileSync(profile.outerPaths.runtimeStatePath));
    const first = managed.coordinator.workers[0];
    const workerId = first.workerId.replace(/worker-\d+$/u, "worker-3");
    fs.mkdirSync(path.join(profile.stateRoot, workerId));
    for (const name of ["codex-model-stream-proxy-runtime.json", "codex-model-stream-proxy.lock.json", "codex-model-stream-proxy.jsonl"]) {
      fs.copyFileSync(path.join(profile.stateRoot, first.workerId, name), path.join(profile.stateRoot, workerId, name));
    }
    managed.coordinator.workers.push({ ...first, workerId });
    managed.coordinator.defaultWorkerId = workerId;
    managed.coordinator.activeHttp = 9;
    managed.coordinator.pendingControl = 0;
    const activationId = crypto.randomUUID();
    managed.coordinator.threads = Array.from({ length: 256 }, (_, index) => ({ threadId: crypto.randomUUID(), turnId: crypto.randomUUID(),
      phase: index >= 253 ? "active" : "terminal",
      workerId: index < 35 ? first.workerId : workerId, activeHttp: index >= 253 ? 3 : 0,
      pendingActivationId: index < 35 ? activationId : null, activationError: null }));
    managed.coordinator.activation = { activationId, active: true, sourceWorkerId: first.workerId, targetWorkerId: workerId,
      deferredThreadIds: managed.coordinator.threads.slice(0, 35).map(thread => thread.threadId) };
    managed.controlRevision = 19;
    managed.controlOperations = managed.coordinator.threads.slice(0, 19).map((thread, index) => ({
      requestId: crypto.randomUUID(), method: "reconcile-terminal", revision: index + 1, state: "completed",
      requestSha256: crypto.createHash("sha256").update(`request-${index}`).digest("hex"), actualMs: index + 1,
      result: { threadId: thread.threadId, turnId: thread.turnId, phase: "terminal",
        evidenceSha256: crypto.createHash("sha256").update(`evidence-${index}`).digest("hex") },
    }));
    outer.proxy.clients = [{ id: "retained-desktop", connectedAt: outer.startedAt }];
    outer.proxy.clientCount = 1;
    outer.proxy.outerRuntime.trackedRequestCount = 10;
    outer.proxy.outerRuntime.pendingToolCount = 2;
    outer.proxy.outerRuntime.activeOperationCount = 1;
    const workerRuntimePath = path.join(profile.stateRoot, workerId, "codex-model-stream-proxy-runtime.json");
    const workerRuntime = JSON.parse(fs.readFileSync(workerRuntimePath));
    workerRuntime.activeRequests = 9;
    fs.writeFileSync(workerRuntimePath, JSON.stringify(workerRuntime));
    const workerBefore = fs.readFileSync(workerRuntimePath);
    outer.proxy.journal.unknownWakeCount = 2;
    outer.proxy.journal.wakeCount = 2;
    fs.writeFileSync(profile.outerPaths.journalPath, JSON.stringify({ schemaVersion: 2, subscriptions: {}, wakes: {
      "unknown-a": { status: "unknown" }, "unknown-b": { status: "unknown" }
    } }));
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outer));
    const writeManaged = value => fs.writeFileSync(profile.managedStatePath, JSON.stringify(value, null, 2));
    writeManaged(managed);
    assert.ok(fs.statSync(profile.managedStatePath).size >= 74000);
    assert.equal(managed.coordinator.threads.filter(thread => thread.phase === "terminal").length, 253);
    assert.equal(managed.coordinator.threads.filter(thread => thread.phase === "active").length, 3);
    assert.throws(() => planInnerStartupRecovery({ ...input, allowInterruptedSnapshot: false }, emptyHost), /IDLE_PROOF_REQUIRED/u);
    const plan = planInnerStartupRecovery(input, emptyHost);
    assert.equal(plan.preservedHistory.threadCount, 256);
    assert.equal(plan.preservedHistory.journalReplayed, false);
    assert.equal(plan.preservedHistory.unknownWakeCount, 2);
    const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const entry = fileURLToPath(new URL("../ops/start-codex-app-server-proxy.ps1", import.meta.url));
    const officialPlan = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", entry,
      "-DataRoot", input.dataRoot, "-DownstreamPort", String(input.ports.downstream),
      "-ControlPort", String(input.ports.control), "-UpstreamPort", String(input.ports.upstream),
      "-ProbePort", String(input.ports.probe), "-StartupRecoveryMode", "Plan"],
    { encoding: "utf8", windowsHide: true, timeout: 30000, env: { ...process.env, CODEX_TOOLKIT_NODE_EXE: process.execPath } });
    assert.equal(officialPlan.status, 0, officialPlan.stderr);
    assert.equal(JSON.parse(officialPlan.stdout).recoverable, true);
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.managedStatePath)), managed);
    for (const change of [
      value => { value.controlOperations = null; },
      value => { value.controlOperations[0] = null; },
      ...["pending", "unknown", "failed"].map(state => value => { value.controlOperations[0].state = state; }),
      ...[true, false].map(pending => value => { value.controlOperations[0].publicationPending = pending; }),
      value => { delete value.controlOperations[0].result; },
      ...[null, [], "invalid"].map(result => value => { value.controlOperations[0].result = result; }),
      value => { value.controlOperations[0].error = { code: "UNRESOLVED" }; },
      value => { value.controlOperations[0].unexpected = true; },
      value => { value.controlOperations[0].method = "unsupported"; },
      value => { value.controlOperations[0].requestId = "invalid request"; },
      value => { value.controlOperations[1].requestId = value.controlOperations[0].requestId; },
      value => { value.controlOperations[0].requestSha256 = "invalid"; },
      value => { value.controlOperations[0].actualMs = -1; },
      value => { value.controlOperations[0].actualMs = null; },
      value => { value.controlOperations[1].revision = value.controlOperations[0].revision; },
      value => { value.controlOperations.reverse(); },
      value => { value.controlOperations[18].revision = 20; },
      value => { value.controlRevision = null; },
      value => { value.controlOperations = Array.from({ length: 129 }, () => value.controlOperations[0]); },
    ]) {
      const altered = structuredClone(managed);
      change(altered);
      writeManaged(altered);
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /STARTUP_RECOVERY_IDLE_PROOF_REQUIRED/u);
    }
    const strictManaged = { ...managed, nativeSource: { ...managed.nativeSource, delivered: 0 },
      coordinator: { ...managed.coordinator, threads: [], activation: null } };
    fs.writeFileSync(profile.managedStatePath, JSON.stringify(strictManaged));
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify({ ...outer, state: "running", proxy: { ...outer.proxy,
      clients: [], clientCount: 0, journal: { ...outer.proxy.journal, wakeCount: 0, unknownWakeCount: 0 } } }));
    fs.writeFileSync(profile.outerPaths.journalPath, JSON.stringify({ schemaVersion: 2, subscriptions: {}, wakes: {} }));
    assert.throws(() => planInnerStartupRecovery({ ...input, historyPolicy: undefined, allowInterruptedSnapshot: false }, emptyHost),
      /STARTUP_RECOVERY_IDLE_PROOF_REQUIRED/u);
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outer));
    fs.writeFileSync(profile.outerPaths.journalPath, JSON.stringify({ schemaVersion: 2, subscriptions: {}, wakes: {
      "unknown-a": { status: "unknown" }, "unknown-b": { status: "unknown" },
    } }));
    writeManaged(managed);
    for (const change of [
      value => { value.controlBusy = true; },
      value => { value.controlOperations = [{ state: "unknown" }]; },
      value => { value.coordinator.transactionActive = true; },
      value => { value.coordinator.workerMaintenance = true; },
      value => { value.coordinator.pendingControl = 1; },
      ...[-1, 1.5, null, "9", Number.MAX_SAFE_INTEGER + 1].flatMap(count => [
        value => { value.coordinator.activeHttp = count; },
        value => { value.coordinator.threads[0].activeHttp = count; },
      ]),
      value => { value.coordinator.threads[0].pendingActivationId = crypto.randomUUID(); },
      value => { value.coordinator.activation.deferredThreadIds.push("missing"); },
    ]) {
      const altered = structuredClone(managed);
      change(altered);
      writeManaged(altered);
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /STARTUP_RECOVERY_/u);
    }
    writeManaged(managed);
    for (const name of ["activeOperationCount", "trackedRequestCount", "pendingToolCount"]) {
      for (const count of [-1, 1.5, null, "9", Number.MAX_SAFE_INTEGER + 1]) {
        const altered = structuredClone(outer);
        altered.proxy.outerRuntime[name] = count;
        fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(altered));
        assert.throws(() => planInnerStartupRecovery(input, emptyHost), /IDLE_PROOF_REQUIRED/u);
      }
    }
    const outerBusy = structuredClone(outer);
    outerBusy.proxy.outerRuntime.busy = true;
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outerBusy));
    assert.throws(() => planInnerStartupRecovery(input, emptyHost), /IDLE_PROOF_REQUIRED/u);
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outer));
    for (const activeRequests of [-1, 1.5, null, "9", Number.MAX_SAFE_INTEGER + 1]) {
      fs.writeFileSync(workerRuntimePath, JSON.stringify({ ...workerRuntime, activeRequests }));
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /WORKER_IDLE_OR_IDENTITY_UNKNOWN/u);
    }
    fs.writeFileSync(workerRuntimePath, workerBefore);
    const withoutActivation = structuredClone(managed);
    withoutActivation.coordinator.activation = null;
    for (const thread of withoutActivation.coordinator.threads) thread.pendingActivationId = null;
    writeManaged(withoutActivation);
    assert.doesNotThrow(() => planInnerStartupRecovery(input, emptyHost));
    writeManaged(managed);
    const reusedProcess = { ProcessId: outer.pid, ParentProcessId: 0, Name: "unrelated.exe", CommandLine: '"C:\\unrelated\\unrelated.exe"',
      CreationDate: new Date(plan.snapshotAt + 10000).toISOString() };
    const reusedHost = () => ({ ...emptyHost(), processes: [reusedProcess] });
    assert.doesNotThrow(() => planInnerStartupRecovery(input, reusedHost));
    for (const mutation of [ { CreationDate: new Date(plan.snapshotAt).toISOString() }, { CommandLine: "" },
      { CommandLine: profile.initial.runnerPath } ]) {
      assert.throws(() => planInnerStartupRecovery(input, () => ({ ...emptyHost(), processes: [{ ...reusedProcess, ...mutation }] })), /STARTUP_RECOVERY_/u);
    }
    assert.throws(() => planInnerStartupRecovery(input, () => ({ ...emptyHost(), listeners: [{ LocalPort: input.ports.control, OwningProcess: 123 }] })), /LISTENER_STILL_PRESENT/u);
    for (const processInfo of [
      { ProcessId: first.pid, ParentProcessId: 0, Name: "node.exe", CommandLine: profile.initial.runnerPath },
      { ProcessId: 999999, ParentProcessId: outer.pid, Name: "child.exe", CommandLine: "child" },
      { ProcessId: 999999, ParentProcessId: 0, Name: "node.exe", CommandLine: profile.initial.runnerPath },
      { ProcessId: 999999, ParentProcessId: 0, Name: "node.exe", CommandLine: null },
    ]) {
      assert.throws(() => planInnerStartupRecovery(input, () => ({ ...emptyHost(), processes: [processInfo] })), /STARTUP_RECOVERY_/u);
    }
    assert.throws(() => planInnerStartupRecovery(input, () => ({ ...emptyHost(), complete: false })), /HOST_INVENTORY_UNKNOWN/u);
    let inventoryCalls = 0;
    assert.throws(() => applyInnerStartupRecovery(input, planInnerStartupRecovery(input, emptyHost), () => {
      inventoryCalls += 1;
      return inventoryCalls > 1 ? { ...emptyHost(), listeners: [{ LocalPort: input.ports.control, OwningProcess: 123 }] } : emptyHost();
    }), /LISTENER_STILL_PRESENT/u);
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.managedStatePath)), managed);
    assert.ok(fs.existsSync(profile.outerPaths.lockPath));
    const journalBefore = fs.readFileSync(profile.outerPaths.journalPath);
    assert.equal(createWakeJournal({ filePath: profile.outerPaths.journalPath }).status().unknownWakeCount, 2);
    for (const invalidJournal of [
      { schemaVersion: 2, wakes: {} },
      { schemaVersion: 2, subscriptions: [], wakes: {} },
      { schemaVersion: 1, wakes: "invalid" },
      { schemaVersion: 2, subscriptions: {}, wakes: { malformed: null } },
    ]) {
      fs.writeFileSync(profile.outerPaths.journalPath, JSON.stringify(invalidJournal));
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /WAKE_RESULT_UNRESOLVED/u);
      assert.deepEqual(JSON.parse(fs.readFileSync(profile.managedStatePath)), managed);
      assert.ok(fs.existsSync(profile.outerPaths.lockPath));
    }
    fs.writeFileSync(profile.outerPaths.journalPath, journalBefore);
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = function (filename, ...args) {
      if (String(filename).endsWith("applied.json")) {
        assert.ok(fs.existsSync(profile.outerPaths.lockPath));
        throw new Error("INJECTED_COMMIT_FAILURE");
      }
      return originalWrite.call(this, filename, ...args);
    };
    try { assert.throws(() => applyInnerStartupRecovery(input, planInnerStartupRecovery(input, emptyHost), emptyHost), /INJECTED_COMMIT_FAILURE/u); }
    finally { fs.writeFileSync = originalWrite; }
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.managedStatePath)), managed);
    assert.ok(fs.existsSync(profile.outerPaths.lockPath));
    const result = applyInnerStartupRecovery(input, planInnerStartupRecovery(input, emptyHost), emptyHost);
    assert.equal(result.recovered, true);
    const recovered = JSON.parse(fs.readFileSync(profile.managedStatePath));
    assert.deepEqual(recovered.coordinator, managed.coordinator);
    assert.deepEqual(recovered.controlOperations, managed.controlOperations);
    assert.equal(recovered.controlRevision, 19);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.evidenceRoot, "manifest.json")));
    const backup = manifest.originals.find(original => original.path === profile.managedStatePath);
    assert.deepEqual(JSON.parse(fs.readFileSync(backup.backupPath)), managed);
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.outerPaths.runtimeStatePath)).proxy, outer.proxy);
    assert.deepEqual(fs.readFileSync(profile.outerPaths.journalPath), journalBefore);
    assert.equal(createWakeJournal({ filePath: profile.outerPaths.journalPath }).status().unknownWakeCount, 2);
    assert.deepEqual(fs.readFileSync(workerRuntimePath), workerBefore);
    assert.equal(fs.existsSync(profile.outerPaths.lockPath), false);
    console.log(JSON.stringify({ completedReceipts: recovered.controlOperations.length, terminalThreads: 253, activeThreads: 3,
      activeHttp: recovered.coordinator.activeHttp, trackedRequestCount: outer.proxy.outerRuntime.trackedRequestCount,
      workerActiveRequests: workerRuntime.activeRequests,
      unknownWakeCount: plan.preservedHistory.unknownWakeCount, managedSnapshotBytes: backup.bytes, journalReplayed: false }));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
