import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planInnerStartupRecovery, applyInnerStartupRecovery } from "../src/inner-startup-residual-recovery.mjs";
import { readInnerRuntimeProfile, saveInnerCandidateRegistry, INNER_RUNTIME_STATE_MAX_BYTES } from "../src/inner-runtime-profile.mjs";
import { parseArguments } from "../src/codex-app-server-proxy-runner.mjs";

const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const emptyHost = () => ({ complete: true, processes: [], listeners: [] });

test("reboot recovery preserves a settled upgrade, later workers and a full bounded terminal snapshot", { timeout: 60000, skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-upgraded-owned-"));
  try {
    const native = fileURLToPath(new URL("./inner-startup-residual-native.mjs", import.meta.url));
    const generated = spawnSync(process.execPath, [native, root, "history"], { encoding: "utf8", windowsHide: true, timeout: 25000 });
    assert.equal(generated.status, 0, generated.stderr);
    const input = { ...JSON.parse(fs.readFileSync(path.join(root, "native-evidence.json"))), historyPolicy: "preserve" };
    const profile = readInnerRuntimeProfile(input.profilePath);
    const managed = JSON.parse(fs.readFileSync(profile.managedStatePath));
    const originalWorker = managed.coordinator.workers[0];
    const workerId = originalWorker.workerId.replace(/worker-\d+$/u, "worker-10");
    const workerRoot = path.join(profile.stateRoot, workerId);
    assert.ok(path.resolve(workerRoot).startsWith(path.resolve(root) + path.sep));
    fs.mkdirSync(workerRoot);
    for (const name of ["codex-model-stream-proxy-runtime.json", "codex-model-stream-proxy.lock.json", "codex-model-stream-proxy.jsonl"]) {
      fs.copyFileSync(path.join(profile.stateRoot, originalWorker.workerId, name), path.join(workerRoot, name));
    }
    const candidateRoot = path.join(root, "approved-upgrade");
    fs.mkdirSync(path.join(candidateRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(candidateRoot, ".inner-runtime-owner.json"), JSON.stringify({ schemaVersion: 1,
      ownerId: profile.ownerId, nativeSourceId: profile.nativeSourceId, kind: "candidate" }));
    const expectedHashes = {};
    for (const [name, file] of Object.entries({ runner: "codex-model-stream-proxy-runner.mjs", core: "codex-model-stream-proxy.mjs",
      helper: "thread-recovery-handoff.mjs", control: "inner-runner-handoff-control.mjs" })) {
      const bytes = Buffer.concat([fs.readFileSync(path.join(profile.installationRoot, "src", file)), Buffer.from("\n")]);
      fs.writeFileSync(path.join(candidateRoot, "src", file), bytes);
      expectedHashes[name] = digest(bytes);
    }
    saveInnerCandidateRegistry(profile, [{ id: "reboot-approved", installationRoot: candidateRoot,
      runnerPath: path.join(candidateRoot, "src", "codex-model-stream-proxy-runner.mjs"), expectedHashes }], null);
    managed.coordinator.workers.push({ ...originalWorker, workerId, sourceHashes: expectedHashes });
    managed.coordinator.defaultWorkerId = workerId;
    managed.coordinator.activeHttp = 0;
    managed.coordinator.pendingControl = 0;
    managed.coordinator.activation = { activationId: crypto.randomUUID(), active: true,
      sourceWorkerId: originalWorker.workerId, targetWorkerId: workerId, deferredThreadIds: [] };
    managed.coordinator.threads = Array.from({ length: 256 }, (_, index) => ({ threadId: `retained-${index}-${"a".repeat(220)}`,
      turnId: `completed-${index}`, phase: "terminal", workerId, activeHttp: 0, pendingActivationId: null, activationError: null }));
    fs.writeFileSync(profile.managedStatePath, JSON.stringify(managed));
    const original = fs.readFileSync(profile.managedStatePath);
    assert.ok(original.length > 65536);
    const plan = planInnerStartupRecovery(input, emptyHost);
    assert.equal(plan.preservedHistory.threadCount, 256);
    assert.ok(plan.originals.some(entry => entry.path.endsWith("inner-candidate-approvals.json")));
    assert.ok(plan.originals.some(entry => entry.path === path.join(candidateRoot, "src", "codex-model-stream-proxy.mjs")));
    for (const change of [
      value => { value.coordinator.activation.deferredThreadIds = ["pending-thread"]; },
      value => { value.coordinator.activation.targetWorkerId = originalWorker.workerId; },
      value => { value.coordinator.activation.active = false; },
      value => { value.coordinator.workers[1].workerId = workerId.replace("10", "9007199254740992"); },
      value => { value.coordinator.workers[1].sourceHashes.core = "0".repeat(64); },
      value => { value.coordinator.threads[0].activeHttp = 1; },
      value => { value.coordinator.threads[0].phase = "active"; },
      value => { value.coordinator.threads[0].activationError = "failed"; },
      value => { value.coordinator.activeHttp = 1; },
      value => { value.coordinator.pendingControl = 1; },
    ]) {
      const changed = structuredClone(managed);
      change(changed);
      fs.writeFileSync(profile.managedStatePath, JSON.stringify(changed));
      assert.throws(() => planInnerStartupRecovery(input, emptyHost), /STARTUP_RECOVERY_/u);
    }
    const rolledBack = structuredClone(managed);
    rolledBack.coordinator.activation.active = false;
    rolledBack.coordinator.defaultWorkerId = originalWorker.workerId;
    fs.writeFileSync(profile.managedStatePath, JSON.stringify(rolledBack));
    assert.doesNotThrow(() => planInnerStartupRecovery(input, emptyHost));
    const oversized = structuredClone(managed);
    oversized.padding = "";
    oversized.padding = "x".repeat(INNER_RUNTIME_STATE_MAX_BYTES - Buffer.byteLength(JSON.stringify(oversized)));
    fs.writeFileSync(profile.managedStatePath, JSON.stringify(oversized));
    const boundedPlan = planInnerStartupRecovery(input, emptyHost);
    const outerBefore = fs.readFileSync(profile.outerPaths.runtimeStatePath);
    assert.throws(() => applyInnerStartupRecovery(input, boundedPlan, emptyHost), /STARTUP_RECOVERY_OUTPUT_TOO_LARGE/u);
    assert.deepEqual(fs.readFileSync(profile.outerPaths.runtimeStatePath), outerBefore);
    assert.ok(fs.existsSync(profile.outerPaths.lockPath));
    assert.equal(fs.existsSync(`${profile.outerPaths.lockPath}.recovery`), false);
    fs.writeFileSync(profile.managedStatePath, original);
    const restoredPlan = planInnerStartupRecovery(input, emptyHost);
    const recovered = applyInnerStartupRecovery(input, restoredPlan, emptyHost);
    const after = JSON.parse(fs.readFileSync(profile.managedStatePath));
    assert.equal(after.state, "closed");
    assert.deepEqual(after.coordinator, managed.coordinator);
    const evidence = JSON.parse(fs.readFileSync(path.join(recovered.evidenceRoot, "manifest.json")));
    const saved = evidence.originals.find(entry => entry.path === profile.managedStatePath);
    assert.deepEqual(fs.readFileSync(saved.backupPath), original);
    const options = parseArguments(["--runtime-state", profile.outerPaths.runtimeStatePath, "--log", profile.outerPaths.logPath,
      "--stop-file", profile.outerPaths.stopFilePath, "--lock", profile.outerPaths.lockPath, "--journal", profile.outerPaths.journalPath,
      "--token-file", profile.outerPaths.tokenFilePath, "--maintenance-file", profile.outerPaths.maintenanceFilePath,
      "--alert-file", profile.outerPaths.alertFilePath, "--fallback-file", profile.outerPaths.fallbackFilePath,
      "--instance-token", crypto.randomUUID(), "--launch-receipt", path.join(root, "new-launch.json"),
      ...Object.entries(input.ports).flatMap(([name, port]) => [`--${name}-port`, String(port)])]);
    assert.doesNotThrow(() => readInnerRuntimeProfile(input.profilePath, { options }));
  } finally {
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
