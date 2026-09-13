import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-watermark-process-"));
process.env.SANDBOX_DATA_ROOT = root;
process.env.SANDBOX_ADMISSION_WAIT_MIN_MS = "200";
process.env.SANDBOX_ADMISSION_WAIT_MAX_MS = "200";
const { resourceAdmission } = await import("../mcps/sandbox/dist/resource-admission-runtime.js");
const { registerExec } = await import("../mcps/sandbox/dist/tools/exec.js");
const { registerBatch } = await import("../mcps/sandbox/dist/tools/batch.js");
const { registerSmartSearch } = await import("../mcps/sandbox/dist/tools/smart-search.js");
let execHandler;
let batchHandler;
let searchHandler;
registerExec({ tool: (_name, _description, _schema, callback) => { execHandler = callback; } });
registerBatch({ tool: (_name, _description, _schema, callback) => { batchHandler = callback; } });
registerSmartSearch({ tool: (_name, _description, _schema, callback) => { searchHandler = callback; } });
const healthy = { systemAvailableMemoryMB: 4096, commitAvailableMemoryMB: 16384, highMemorySignaled: true, lowMemorySignaled: false };
let pressure = { ...healthy };
const applyPressure = resourceAdmission.updateSystemPressure.bind(resourceAdmission);
resourceAdmission.updateSystemPressure = () => applyPressure(pressure);
const refresh = setInterval(() => resourceAdmission.updateSystemPressure(), 100);
resourceAdmission.updateSystemPressure();
const existing = resourceAdmission.adopt(4096);
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const reports = [];

function parameters(marker, extra = {}) {
    return {
        language: "node", cwd: root, ownerId: `watermark-${marker}`,
        code: `const fs=require('node:fs');const data=Buffer.alloc(24*1024*1024,7);fs.writeFileSync(${JSON.stringify(path.join(root, marker))},String(data[0]));setTimeout(()=>console.log(${JSON.stringify(marker)}),50);`,
        memoryRequestMB: 24, maxMemoryMB: 256, timeout: 15000, admissionBudgetMs: 1500,
        ...extra,
    };
}

function queueWaitMs(result) {
    const match = result.content[0].text.match(/排队 ([\d.]+)(ms|s)/);
    assert.ok(match);
    return Number(match[1]) * (match[2] === "s" ? 1000 : 1);
}

async function blocked(marker, nextPressure) {
    pressure = nextPressure;
    resourceAdmission.updateSystemPressure();
    const result = await execHandler(parameters(marker, { admissionBudgetMs: 100 }), { signal: new AbortController().signal });
    assert.equal(result.structuredContent.error.commandStarted, false);
    assert.equal(result.structuredContent.error.type, "admission_timeout");
    assert.ok(result.content[0].text.includes("实际阻断"));
    assert.ok(result.content[0].text.includes("有效请求：24MB"));
    assert.equal(fs.existsSync(path.join(root, marker)), false);
    return result.structuredContent.error.admissionDecision.blockedBy;
}

try {
    await delay(1200);
    assert.equal(resourceAdmission.getState().startupReservedMB, 0);
    for (const concurrency of [1, 5, 10, 20]) {
        const startedAt = Date.now();
        const results = await Promise.all(Array.from({ length: concurrency }, (_, index) => execHandler(parameters(`burst-${concurrency}-${index}`), { signal: new AbortController().signal })));
        assert.ok(results.every((result) => !result.isError && result.content[0].text.startsWith("✅ 成功")), JSON.stringify(results));
        for (let index = 0; index < concurrency; index += 1) assert.equal(fs.readFileSync(path.join(root, `burst-${concurrency}-${index}`), "utf8"), "7");
        reports.push({ concurrency, completed: results.length, elapsedMs: Date.now() - startedAt, maxQueueWaitMs: Math.max(...results.map(queueWaitMs)) });
    }
    const dangerous = [];
    dangerous.push(await blocked("physical-blocked", { ...healthy, systemAvailableMemoryMB: 510 }));
    dangerous.push(await blocked("commit-blocked", { ...healthy, commitAvailableMemoryMB: 1530 }));
    dangerous.push(await blocked("signal-blocked", { ...healthy, lowMemorySignaled: true }));
    pressure = { ...healthy, lowMemorySignaled: true };
    resourceAdmission.updateSystemPressure();
    const cancel = new AbortController();
    const pending = execHandler(parameters("cancelled-queued"), { signal: cancel.signal });
    await delay(30);
    cancel.abort();
    await pending;
    pressure = { ...healthy };
    resourceAdmission.updateSystemPressure();
    await delay(50);
    assert.equal(fs.existsSync(path.join(root, "cancelled-queued")), false);
    const batch = await batchHandler({ tasks: Array.from({ length: 5 }, (_, index) => parameters(`batch-${index}`)), maxParallel: 5, maxTotalMemoryMB: 512, ownerId: "watermark-batch" }, { signal: new AbortController().signal });
    assert.ok(!batch.isError);
    for (let index = 0; index < 5; index += 1) assert.equal(fs.existsSync(path.join(root, `batch-${index}`)), true);
    pressure = { ...healthy, systemAvailableMemoryMB: 510 };
    resourceAdmission.updateSystemPressure();
    const blockedBatch = await batchHandler({ tasks: [parameters("blocked-batch")], ownerId: "watermark-blocked-batch", admissionBudgetMs: 100 }, { signal: new AbortController().signal });
    assert.ok(blockedBatch.content.some((item) => item.text?.includes("实际阻断")));
    assert.equal(fs.existsSync(path.join(root, "blocked-batch")), false);
    const blockedSearch = await searchHandler({ queries: [{ query: "needle-a" }, { query: "needle-b" }], mode: "exact", searchPath: root, ownerId: "watermark-blocked-search" }, { signal: new AbortController().signal });
    assert.equal(blockedSearch.content[0].text.split("实际阻断").length, 3);
    assert.ok(blockedSearch.content[0].text.includes("physical_headroom"));
    pressure = { ...healthy };
    resourceAdmission.updateSystemPressure();
    const recovered = await execHandler(parameters("recovered"), { signal: new AbortController().signal });
    assert.ok(recovered.content[0].text.startsWith("✅ 成功"));
    assert.equal(fs.existsSync(path.join(root, "recovered")), true);
    existing.release();
    assert.equal(resourceAdmission.getState().activeLeases, 0);
    assert.equal(resourceAdmission.getState().startupReservedMB, 0);
    console.log(JSON.stringify({ kind: "real-Windows-processes-with-injected-pressure", reports, dangerous, executed: 42, prevented: 5, rejectedSearchesWithDiagnostics: 2, finalLeases: 0 }));
} finally {
    existing.release();
    clearInterval(refresh);
    fs.rmSync(root, { recursive: true, force: true });
}
