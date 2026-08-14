import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-smart-search-isolation-"));
const searchRoot = path.join(dataRoot, "search-root");
process.env.SANDBOX_DATA_ROOT = path.join(dataRoot, "runtime");
fs.mkdirSync(searchRoot, { recursive: true });

for (let index = 0; index < 400; index += 1) {
    fs.writeFileSync(
        path.join(searchRoot, `match-${String(index).padStart(4, "0")}.txt`),
        Array.from({ length: 100 }, (_, line) => `needle ${index} ${line}`).join("\n"),
        "utf8",
    );
}

const { preprocessSearch, registerSmartSearch } = await import("../mcps/sandbox/dist/tools/smart-search.js");
const { registerStatus } = await import("../mcps/sandbox/dist/tools/status.js");
const { scanDirectory } = await import("../mcps/sandbox/dist/symbol-index.js");
const {
    cancelBackgroundTask,
    startBackgroundTask,
    waitForBackgroundTask,
} = await import("../mcps/sandbox/dist/background-tasks.js");
const { getResourceAdmissionState } = await import("../mcps/sandbox/dist/resource-admission-runtime.js");

function captureTool(register, expectedName) {
    let handler;
    const server = {
        tool(name, _description, _shape, registeredHandler) {
            assert.equal(name, expectedName);
            handler = registeredHandler;
        },
        registerTool(name, config, registeredHandler) {
            assert.equal(name, expectedName);
            assert.ok(config.inputSchema);
            handler = registeredHandler;
        },
    };
    register(server);
    assert.equal(typeof handler, "function");
    return handler;
}

const smartSearch = captureTool(registerSmartSearch, "smart_search");
const status = captureTool(registerStatus, "sandbox_status");

const searchPromise = smartSearch({
    query: "needle",
    mode: "exact",
    searchPath: searchRoot,
    maxResults: 50,
    context: 2,
    ownerId: "smart-search-isolation-test",
}, {});

const statusStartedAt = Date.now();
const statusResult = await status({ action: "overview" });
const statusLatencyMs = Date.now() - statusStartedAt;
assert.ok(statusLatencyMs < 1000, `sandbox_status was blocked for ${statusLatencyMs}ms`);
assert.match(statusResult.content[0].text, /事件循环延迟/u);

const searchResult = await searchPromise;
assert.match(searchResult.content[0].text, /50 条结果/u);
assert.match(searchResult.content[0].text, /ripgrep \(global cap\)/u);
assert.equal(getResourceAdmissionState().activeLeases, 0);

const indexRoot = path.join(dataRoot, "index-root");
fs.mkdirSync(indexRoot, { recursive: true });
for (let index = 0; index < 600; index += 1) {
    fs.writeFileSync(path.join(indexRoot, `file-${index}.ts`), `export const value${index} = ${index};\n`, "utf8");
}
const oversizedPath = path.join(indexRoot, "oversized.ts");
fs.writeFileSync(oversizedPath, `export const huge = "${"x".repeat(3 * 1024 * 1024)}";`, "utf8");
let yielded = false;
setImmediate(() => { yielded = true; });
const index = await scanDirectory(indexRoot);
assert.equal(yielded, true, "symbol indexing never yielded to the event loop");
assert.equal(index.has(oversizedPath), false, "oversized source file was parsed instead of skipped");
assert.ok(index.size >= 500);

const scanCancellation = new AbortController();
setImmediate(() => scanCancellation.abort(new Error("scan-cancelled")));
await assert.rejects(
    preprocessSearch("value", indexRoot, { signal: scanCancellation.signal }),
    /取消|scan-cancelled/u,
);

const ownerId = "background-cancel-owner";
const task = startBackgroundTask("smart-search-test", async (_progress, signal) => await new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
}), { ownerId, maxRunMs: 30000 });
const cancellation = cancelBackgroundTask(task.id, ownerId);
assert.ok(cancellation && !("forbidden" in cancellation));
const cancelledTask = await waitForBackgroundTask(task.id, 1, ownerId);
assert.ok(cancelledTask && !("forbidden" in cancelledTask));
assert.equal(cancelledTask.status, "error");
assert.match(cancelledTask.error || "", /取消/u);

console.log("6/6 sandbox smart-search isolation checks passed");

fs.rmSync(dataRoot, { recursive: true, force: true });
