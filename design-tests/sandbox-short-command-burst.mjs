import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-short-command-burst-"));
process.env.SANDBOX_DATA_ROOT = dataRoot;
process.env.SANDBOX_ADMISSION_SYSTEM_HEADROOM_MB = "0";

const { execute } = await import("../mcps/sandbox/dist/executor.js");

try {
    const startedAt = Date.now();
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => execute({
        language: "powershell",
        code: `Start-Sleep -Milliseconds 200; Write-Output "burst-ok-${index}"`,
        memoryRequestMB: 16,
        maxMemoryMB: 128,
        timeout: 10_000,
        admissionBudgetMs: 10_000,
    })));
    const elapsedMs = Date.now() - startedAt;

    assert.equal(results.filter(result => result.exitCode === 0).length, 20);
    assert.equal(results.filter(result => result.killed).length, 0);
    assert.equal(results.filter(result => typeof result.peakMemoryMB === "number" && result.peakMemoryMB > 0).length, 20);
    assert.equal(results.filter(result => result.stdout.includes("burst-ok-")).length, 20);
    assert.ok(Math.max(...results.map(result => result.queueWaitMs)) < 10_000);

    console.log(JSON.stringify({
        completed: results.length,
        elapsedMs,
        maxQueueWaitMs: Math.max(...results.map(result => result.queueWaitMs)),
        minPeakMemoryMB: Math.min(...results.map(result => result.peakMemoryMB ?? 0)),
        maxPeakMemoryMB: Math.max(...results.map(result => result.peakMemoryMB ?? 0)),
    }));
} finally {
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
