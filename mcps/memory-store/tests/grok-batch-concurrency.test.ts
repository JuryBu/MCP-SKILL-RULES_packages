import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";

function success(prompt: string): { choices: Array<{ message: { content: string }; finish_reason: string }> } {
    return { choices: [{ message: { content: `ok:${prompt}` }, finish_reason: "stop" }] };
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
        if (predicate()) return;
        await delay(10);
    }
    throw new Error(message);
}

const heldResponses: Array<() => void> = [];
let holdResponses = false;
let active = 0;
let maxActive = 0;
let requestCount = 0;
const server = http.createServer((request, response) => {
    if (request.url === "/v1/models" && request.method === "GET") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "grok-bridge" }] }));
        return;
    }
    if (request.url !== "/v1/chat/completions" || request.method !== "POST") {
        response.writeHead(404);
        response.end("not found");
        return;
    }
    let raw = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { raw += chunk; });
    request.on("end", () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        requestCount += 1;
        const prompt = String(JSON.parse(raw || "{}").messages?.[0]?.content || "");
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            active = Math.max(0, active - 1);
        };
        response.on("close", finish);
        const complete = () => {
            if (!response.writableEnded && !response.destroyed) {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify(success(prompt)));
            }
            finish();
        };
        if (holdResponses) heldResponses.push(complete);
        else complete();
    });
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.equal(typeof address, "object");
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address!.port}`;
process.env.MEMORY_STORE_GROK_API_KEY = "test-key";
process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = "1";
process.env.MEMORY_STORE_GROK_BATCH_CONCURRENCY = "1";
process.env.MEMORY_STORE_GROK_QUEUE_TIMEOUT_MS = "1";

const { callGrokExec, resetGrokCallConcurrencyForTest } = await import("../src/grok-client.ts");
const {
    configureProviderTransportAdapterForTest,
    getProviderTransportAdapter,
    resetProviderTransportAdapterForTest,
} = await import("../src/provider-transport-adapter.ts");

try {
    await configureProviderTransportAdapterForTest({ mode: "shadow" });
    resetGrokCallConcurrencyForTest();
    holdResponses = true;
    const batchCalls = Array.from({ length: 5 }, (_, index) => callGrokExec(
        `unified-record-${index}`,
        "grok-batch",
        2_000,
        128,
        { context: "record", trafficClass: "record-batch" },
    ));
    await waitFor(() => requestCount === 5, "retired Grok batch gate still blocked a record request before provider transport");
    assert.equal(active, 5, "legacy batch concurrency env must not create a second physical gate");
    assert.equal(maxActive, 5);
    while (heldResponses.length > 0) heldResponses.shift()!();
    const batchResults = await Promise.all(batchCalls);
    assert.ok(batchResults.every(result => result.text?.startsWith("ok:unified-record-")));
    assert.ok(batchResults.every(result => result.diagnostics?.trafficClass === "record-batch"));

    holdResponses = false;
    const foreground = await callGrokExec("unified-foreground", "grok-foreground", 1_000);
    assert.equal(foreground.text, "ok:unified-foreground", foreground.error);
    const diagnostics = getProviderTransportAdapter().diagnostics();
    assert.equal(diagnostics.acquireCount, 6);
    assert.deepEqual(diagnostics.attempts.slice(0, 5).map(attempt => attempt.trafficClass), Array(5).fill("record"));
    assert.equal(diagnostics.attempts[5]?.trafficClass, "foreground");
    assert.equal(diagnostics.attempts.every(attempt => attempt.permitSettled), true);
} finally {
    while (heldResponses.length > 0) heldResponses.shift()!();
    await resetProviderTransportAdapterForTest();
    delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    delete process.env.MEMORY_STORE_GROK_API_KEY;
    delete process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
    delete process.env.MEMORY_STORE_GROK_BATCH_CONCURRENCY;
    delete process.env.MEMORY_STORE_GROK_QUEUE_TIMEOUT_MS;
    resetGrokCallConcurrencyForTest();
    await new Promise<void>(resolve => server.close(() => resolve()));
}

console.log("grok batch compatibility tests passed");
