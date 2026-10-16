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

const emptyHost = () => ({ complete: true, processes: [], listeners: [] });

test("dead interrupted snapshots retain clients, deferred threads and UNKNOWN history without replay", { timeout: 60000, skip: process.platform !== "win32" }, () => {
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
    managed.coordinator.activeHttp = 0;
    managed.coordinator.pendingControl = 0;
    const activationId = crypto.randomUUID();
    managed.coordinator.threads = Array.from({ length: 256 }, (_, index) => ({ threadId: `thread-${index}`, phase: index > 253 ? "active" : "terminal",
      workerId: index < 35 ? first.workerId : workerId, activeHttp: 0, pendingActivationId: index < 35 ? activationId : null, activationError: null }));
    managed.coordinator.activation = { activationId, active: true, sourceWorkerId: first.workerId, targetWorkerId: workerId,
      deferredThreadIds: managed.coordinator.threads.slice(0, 35).map(thread => thread.threadId) };
    outer.proxy.clients = [{ id: "retained-desktop", connectedAt: outer.startedAt }];
    outer.proxy.clientCount = 1;
    outer.proxy.journal.unknownWakeCount = 2;
    outer.proxy.journal.wakeCount = 2;
    fs.writeFileSync(profile.outerPaths.journalPath, JSON.stringify({ schemaVersion: 2, wakes: {
      "unknown-a": { state: "unknown" }, "unknown-b": { state: "unknown" }
    } }));
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outer));
    const writeManaged = value => fs.writeFileSync(profile.managedStatePath, JSON.stringify(value));
    writeManaged(managed);
    assert.throws(() => planInnerStartupRecovery({ ...input, allowInterruptedSnapshot: false }, emptyHost), /IDLE_PROOF_REQUIRED/u);
    const plan = planInnerStartupRecovery(input, emptyHost);
    assert.equal(plan.preservedHistory.threadCount, 256);
    assert.equal(plan.preservedHistory.journalReplayed, false);
    for (const change of [
      value => { value.controlBusy = true; },
      value => { value.controlOperations = [{ state: "unknown" }]; },
      value => { value.coordinator.transactionActive = true; },
      value => { value.coordinator.workerMaintenance = true; },
      value => { value.coordinator.pendingControl = 1; },
      value => { value.coordinator.activeHttp = 1; },
      value => { value.coordinator.threads[0].activeHttp = 1; },
      value => { value.coordinator.threads[0].pendingActivationId = crypto.randomUUID(); },
      value => { value.coordinator.activation.deferredThreadIds.push("missing"); },
    ]) {
      const altered = structuredClone(managed);
      change(altered);
      writeManaged(altered);
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /STARTUP_RECOVERY_/u);
    }
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
    const journalBefore = fs.readFileSync(profile.outerPaths.journalPath);
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
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.managedStatePath)).coordinator, managed.coordinator);
    assert.deepEqual(JSON.parse(fs.readFileSync(profile.outerPaths.runtimeStatePath)).proxy, outer.proxy);
    assert.deepEqual(fs.readFileSync(profile.outerPaths.journalPath), journalBefore);
    assert.equal(fs.existsSync(profile.outerPaths.lockPath), false);
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
