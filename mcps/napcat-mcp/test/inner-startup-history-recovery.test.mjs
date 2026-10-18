import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { planInnerStartupRecovery, applyInnerStartupRecovery } from "../src/inner-startup-residual-recovery.mjs";

test("dead native business instance retains completed and interrupted history and unknown journal without replay", { timeout: 45000, skip: process.platform !== "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "startup-history-owned-"));
  try {
    const native = fileURLToPath(new URL("./inner-startup-residual-native.mjs", import.meta.url));
    const generated = spawnSync(process.execPath, [native, root, "history"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    assert.equal(generated.status, 0, generated.stderr);
    const base = JSON.parse(fs.readFileSync(path.join(root, "native-evidence.json")));
    const profile = JSON.parse(fs.readFileSync(base.profilePath));
    const originalManaged = fs.readFileSync(profile.managedStatePath);
    const managed = JSON.parse(originalManaged);
    assert.equal(managed.coordinator.threads.length, 2);
    assert.deepEqual(new Set(managed.coordinator.threads.map(thread => thread.phase)), new Set(["active", "terminal"]));
    assert.ok(managed.nativeSource.delivered >= 3);
    const journal = Buffer.from(JSON.stringify({ schemaVersion: 2, subscriptions: {}, wakes: {
      "owned-unknown": { status: "unknown", command: "never-replay", outcomeUnknown: true, text: "retained".repeat(150000) },
      "owned-completed": { status: "completed", turnId: "completed-turn" },
    } }));
    fs.writeFileSync(profile.outerPaths.journalPath, journal);
    const outer = JSON.parse(fs.readFileSync(profile.outerPaths.runtimeStatePath));
    outer.state = "restarting";
    outer.proxy.journal.unknownWakeCount = 1;
    outer.proxy.journal.wakeCount = 2;
    fs.writeFileSync(profile.outerPaths.runtimeStatePath, JSON.stringify(outer));
    assert.throws(() => planInnerStartupRecovery(base), /IDLE_PROOF_REQUIRED/);
    const input = { ...base, historyPolicy: "preserve" };
    const plan = planInnerStartupRecovery(input);
    assert.deepEqual(plan.preservedHistory, { deliveredEvents: managed.nativeSource.delivered, threadCount: 2, unknownWakeCount: 1, journalReplayed: false });
    assert.throws(() => planInnerStartupRecovery(input, () => ({ complete: true, processes: [{ ProcessId: base.workers[0] }], listeners: [] })), /PROCESS_STILL_PRESENT/);
    assert.throws(() => planInnerStartupRecovery(input, () => ({ complete: false, processes: [], listeners: [] })), /INVENTORY_UNKNOWN/);
    const result = applyInnerStartupRecovery(input, plan);
    assert.equal(result.recovered, true);
    assert.deepEqual(fs.readFileSync(profile.outerPaths.journalPath), journal);
    const terminal = JSON.parse(fs.readFileSync(profile.managedStatePath));
    assert.equal(terminal.state, "closed");
    assert.deepEqual(terminal.coordinator.threads, managed.coordinator.threads);
    assert.equal(terminal.nativeSource.delivered, managed.nativeSource.delivered);
    const manifest = JSON.parse(fs.readFileSync(path.join(result.evidenceRoot, "manifest.json")));
    const backup = manifest.originals.find(entry => entry.path === profile.managedStatePath);
    assert.deepEqual(fs.readFileSync(backup.backupPath), originalManaged);
    assert.equal(fs.existsSync(profile.outerPaths.lockPath), false);
    assert.equal(fs.existsSync(`${profile.outerPaths.lockPath}.recovery`), false);
    console.log(JSON.stringify({ historyPolicy: plan.historyPolicy, preserved: plan.preservedHistory, preservedJournalBytes: journal.length, productionActions: 0 }));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
