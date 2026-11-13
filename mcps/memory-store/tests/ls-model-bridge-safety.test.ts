import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";

let mode: "disconnect" | "internal" | "quota" | "auth" | "hang" = "disconnect";
let generations = 0;
let grokGenerations = 0;
const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/models") { response.end('{"data":[{"id":"fixture"}]}'); return; }
        if (request.url === "/v1/chat/completions") { grokGenerations++; response.statusCode = 502; response.end('{"error":{"message":"fixture rejected"}}'); return; }
        if (request.url?.endsWith("/GetUserStatus")) {
            response.end(JSON.stringify({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [{ label: "Gemini 3.8 Flash (High)", modelId: "gemini-3.8-flash-high", modelOrAlias: { model: "MODEL_PLACEHOLDER_M318" }, quotaInfo: { remainingFraction: 1 } }] } } }));
            return;
        }
        if (request.url?.endsWith("/GetModelResponse")) {
            generations++;
            if (mode === "disconnect") { response.destroy(); return; }
            if (mode === "hang") return;
            response.statusCode = mode === "internal" ? 500 : mode === "quota" ? 429 : 403;
            response.end(JSON.stringify({ message: `fixture ${mode}` }));
            return;
        }
        response.statusCode = 404;
        response.end("{}");
    });
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const port = (server.address() as AddressInfo).port;
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${port}`;
process.env.MEMORY_STORE_AGY_AUTO_ENABLED = "0";
process.env.MEMORY_STORE_CODEX_COMMAND = process.execPath;
const ls = await import("../src/ls-client.ts");
const bridge = await import("../src/model-bridge.ts");
const transport = await import("../src/provider-transport-adapter.ts");
ls.__setParentLsForTest({ info: { pid: process.pid, csrfToken: "synthetic", workspaceId: "", ports: [port], transport: "app" }, port });
await transport.configureProviderTransportAdapterForTest({ mode: "shadow" });
try {
    for (const failureMode of ["disconnect", "internal", "quota", "auth"] as const) {
        mode = failureMode;
        const before = generations;
        const grokBefore = grokGenerations;
        const result = await bridge.callModelResponse("MODEL_PLACEHOLDER_M318", "synthetic only", "auto", 2000);
        assert.equal(result.text, null);
        assert.equal(result.modelUsed, "MODEL_PLACEHOLDER_M318");
        assert.equal(result.chainUsed, null);
        assert.equal(result.codexDiagnostics, undefined);
        assert.equal(generations, before + 1);
        assert.equal(grokGenerations, grokBefore + 1);
        if (failureMode === "disconnect" || failureMode === "internal") assert.equal(result.failureClass, "UnknownOutcome");
        else assert.equal(result.safetyStopped, true);
    }
    mode = "hang";
    const before = generations;
    const timeout = await bridge.callModelResponse("MODEL_PLACEHOLDER_M318", "synthetic only", "antigravity", 70);
    assert.equal(timeout.timedOut, true);
    assert.equal(generations, before + 1);
    assert.equal(timeout.codexDiagnostics, undefined);
    console.log("ls-model-bridge-safety.test.ts PASS: Grok order retained, LS unknown/auth/quota stop before Codex, single timeout request");
} finally {
    ls.__resetLsTestOverridesForTest();
    await transport.resetProviderTransportAdapterForTest();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
}
