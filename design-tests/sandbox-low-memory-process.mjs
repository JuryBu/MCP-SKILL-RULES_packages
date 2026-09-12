import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-pressure-process-"));
process.env.SANDBOX_DATA_ROOT = dataRoot;
const { resourceAdmission } = await import("../mcps/sandbox/dist/resource-admission-runtime.js");
const { registerExec } = await import("../mcps/sandbox/dist/tools/exec.js");
const { registerBatch } = await import("../mcps/sandbox/dist/tools/batch.js");
let handler;
registerExec({ tool: (name, description, schema, callback) => { handler = callback; } });
let batchHandler;
registerBatch({ tool: (name, description, schema, callback) => { batchHandler = callback; } });
let pressure = {
    systemAvailableMemoryMB: 726, commitAvailableMemoryMB: 7252,
    highMemorySignaled: false, lowMemorySignaled: false,
};
const applyPressure = resourceAdmission.updateSystemPressure.bind(resourceAdmission);
resourceAdmission.updateSystemPressure = () => applyPressure(pressure);
resourceAdmission.updateSystemPressure();
const refresh = setInterval(() => resourceAdmission.updateSystemPressure(), 100);
const holders = [resourceAdmission.adopt(192), resourceAdmission.adopt(192)];
const started = performance.now();

async function command(marker, admissionBudgetMs = 1500) {
    return handler({
        code: `require("fs").writeFileSync(${JSON.stringify(path.join(dataRoot, marker))}, "started"); process.stdout.write(${JSON.stringify(marker)});`,
        language: "node", cwd: dataRoot, memoryRequestMB: 64, maxMemoryMB: 256,
        timeout: 10000, admissionBudgetMs, ownerId: `pressure-${marker}`,
    }, { signal: new AbortController().signal });
}

try {
    const first = await command("small-accepted");
    assert.notEqual(first.isError, true);
    assert.ok(first.content.some((item) => item.text?.includes("small-accepted")));
    assert.equal(fs.readFileSync(path.join(dataRoot, "small-accepted"), "utf8"), "started");
    for (const [marker, change, reason] of [
        ["red-blocked", { lowMemorySignaled: true }, "windows_low_memory"],
        ["commit-blocked", { commitAvailableMemoryMB: 1535 }, "commit_headroom"],
        ["physical-blocked", { systemAvailableMemoryMB: 511 }, "physical_headroom"],
    ]) {
        const original = pressure;
        pressure = { ...pressure, ...change };
        resourceAdmission.updateSystemPressure();
        const result = await command(marker, 100);
        const error = result.structuredContent.error;
        assert.equal(error.type, "admission_timeout");
        assert.equal(error.commandStarted, false);
        assert.equal(error.mayHaveStarted, false);
        assert.ok(error.admissionDecision.blockedBy.includes(reason));
        assert.equal(fs.existsSync(path.join(dataRoot, marker)), false);
        pressure = original;
        resourceAdmission.updateSystemPressure();
    }
    resourceAdmission.setRecoveryPending(true);
    const recovering = await command("recovery-blocked", 100);
    assert.ok(recovering.structuredContent.error.admissionDecision.blockedBy.includes("resource_recovery_pending"));
    assert.equal(fs.existsSync(path.join(dataRoot, "recovery-blocked")), false);
    const blockedBatch = await batchHandler({
        tasks: [{ code: "process.stdout.write('must-not-run')", language: "node" }],
        ownerId: "pressure-batch", memoryRequestMB: 64, maxMemoryMB: 256, admissionBudgetMs: 100,
    });
    const batchTask = blockedBatch.structuredContent.tasks[0];
    assert.equal(batchTask.commandStarted, false);
    assert.equal(batchTask.mayHaveStarted, false);
    assert.ok(batchTask.admissionDecision.blockedBy.includes("resource_recovery_pending"));
    resourceAdmission.setRecoveryPending(false);
    const batchStarted = performance.now();
    const burst = await Promise.all(Array.from({ length: 20 }, (_, index) => command(`burst-${index}`, 10000)));
    for (const [index, result] of burst.entries()) {
        assert.notEqual(result.isError, true);
        assert.equal(fs.readFileSync(path.join(dataRoot, `burst-${index}`), "utf8"), "started");
    }
    const state = resourceAdmission.getState();
    assert.equal(state.activeReservedMB, 384);
    assert.equal(state.activeLeases, 2);
    assert.equal(state.queued, 0);
    console.log(JSON.stringify({
        passed: 7, realCommands: 21, blockedBeforeSpawn: 5,
        burstMs: Math.round(performance.now() - batchStarted),
        totalMs: Math.round(performance.now() - started),
        peakReservedMB: state.peak.activeReservedMB,
        pressure: "injected exact incident values; real Windows child execution; no system-memory stress",
    }));
} finally {
    clearInterval(refresh);
    holders.forEach((holder) => holder.release());
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
process.exit(0);
