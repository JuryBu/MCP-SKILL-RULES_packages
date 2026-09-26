import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-unknown-outcome-"));
process.env.MEMORY_STORE_DATA_ROOT = root;
process.env.MEMORY_STORE_AUTO_RECORD = "0";
process.env.MEMORY_STORE_CODEX_COMMAND = path.join(root, "unavailable-codex.cmd");
delete process.env.MEMORY_STORE_AGY_AUTO_ENABLED;
let mode = "disconnect";
let grokCalls = 0;
let lsCalls = 0;
const server = http.createServer((request, response) => {
    request.resume();
    request.once("end", () => {
        if (request.url === "/v1/models") { response.end('{"data":[]}'); return; }
        if (request.url === "/v1/chat/completions") {
            grokCalls++;
            if (mode === "disconnect") {
                response.writeHead(200, { "content-type": "application/json", "content-length": "9999" });
                response.write('{"choices":');
                setTimeout(() => response.destroy(), 30);
            } else {
                response.writeHead(502);
                response.end("synthetic rejection");
            }
            return;
        }
        if (request.url?.endsWith("/Heartbeat")) { response.end("{}"); return; }
        if (request.url?.endsWith("/GetModelResponse")) { lsCalls++; response.end('{"response":"fake LS answer"}'); return; }
        response.writeHead(404);
        response.end();
    });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address() as import("node:net").AddressInfo;
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address.port}`;
process.env.MEMORY_STORE_GROK_API_KEY = "synthetic-test-key";
const ls = await import("../src/ls-client.ts");
ls.__setParentLsForTest({ info: { pid: process.pid, csrfToken: "synthetic", workspaceId: "synthetic", ports: [address.port] }, port: address.port });
const bridge = await import("../src/model-bridge.ts");
const transport = await import("../src/provider-transport-adapter.ts");
await transport.configureProviderTransportAdapterForTest({ mode: "shadow" });
try {
    for (const chain of ["grok", "auto"] as const) {
        const beforeGrok = grokCalls;
        const result = await bridge.callModelResponse("flash", "synthetic only", chain, 3000);
        assert.equal(result.text, null);
        assert.equal(result.failureClass, "UnknownOutcome");
        assert.equal(grokCalls, beforeGrok + 1);
        assert.equal(lsCalls, 0, "an accepted but incomplete request must not be repeated on another provider");
    }
    const taskPath = path.join(root, "Task.md");
    const planPath = path.join(root, "Plan.md");
    fs.writeFileSync(taskPath, "# Task\n## Stage 1\n- [x] synthetic complete\n");
    fs.writeFileSync(planPath, "# Plan\n## Stage 1\nVerify synthetic complete.\n");
    const { runGuardCheck } = await import("../src/guard-engine.ts");
    const beforeGuard = grokCalls;
    const guard = await runGuardCheck({ active: true, guardId: "unknown-outcome-guard", conversationId: "", modelChain: "auto", stageId: "Stage 1", childScopeId: "main", scopeSelectors: [], taskFiles: [taskPath], planFiles: [planPath], startRound: 1, startedAt: new Date().toISOString(), checkHistory: [] });
    assert.equal(guard.passed, false);
    assert.equal(guard.infrastructureError, true);
    assert.equal(grokCalls, beforeGuard + 1, "Guard must stop at the first unknown request result");
    assert.equal(lsCalls, 0);
    mode = "rejected";
    const fallback = await bridge.callModelResponse("flash", "synthetic only", "auto", 3000);
    assert.equal(fallback.text, "fake LS answer");
    assert.equal(lsCalls, 1, "a complete deterministic HTTP rejection retains the existing fallback");
    console.log("Grok accepted-body disconnect: explicit/auto/Guard stop once; complete 502 retains fallback");
} finally {
    await transport.resetProviderTransportAdapterForTest();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
}
