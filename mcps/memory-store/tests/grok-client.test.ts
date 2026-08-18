import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-grok-client-test-"));
process.env.MEMORY_STORE_DATA_ROOT = path.join(tempDir, "data");

let mode: "success" | "empty" | "length" | "length-empty" | "status-429" | "status-502" | "delay" = "success";
let modelsOk = true;
let lastBody: any = null;
let lastAuth = "";

const server = http.createServer((req, res) => {
    lastAuth = String(req.headers.authorization || "");
    if (req.url === "/v1/models") {
        res.writeHead(modelsOk ? 200 : 503, { "content-type": "application/json" });
        res.end(modelsOk ? JSON.stringify({ data: [{ id: "grok-test" }] }) : JSON.stringify({ error: "down" }));
        return;
    }
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404);
        res.end("not found");
        return;
    }

    let raw = "";
    req.setEncoding("utf-8");
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
        lastBody = raw ? JSON.parse(raw) : null;
        if (mode === "delay") {
            setTimeout(() => {
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { content: "late" }, finish_reason: "stop" }] }));
            }, 200);
            return;
        }
        if (mode === "status-429") {
            res.writeHead(429, { "content-type": "text/plain" });
            res.end("rate limited");
            return;
        }
        if (mode === "status-502") {
            res.writeHead(502, { "content-type": "text/plain" });
            res.end("bad gateway");
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (mode === "length-empty") {
            res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }));
            return;
        }
        if (mode === "empty") {
            res.end(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "stop" }] }));
            return;
        }
        if (mode === "length") {
            res.end(JSON.stringify({ choices: [{ message: { content: "partial grok output" }, finish_reason: "length" }] }));
            return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: "ok from grok" }, finish_reason: "stop" }] }));
    });
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.equal(typeof address, "object");
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address!.port}`;
process.env.MEMORY_STORE_GROK_API_KEY = "test-key";
process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = "8";

const {
    callGrokExec,
    isGrokBridgeAvailable,
    mapGrokMaxTokens,
    mapGrokModel,
    resetGrokBridgeAvailabilityForTest,
    resetGrokCallConcurrencyForTest,
} = await import("../src/grok-client.ts");
const { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
await configureProviderTransportAdapterForTest({ mode: "shadow" });

try {
    mode = "success";
    const success = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(success.text, "ok from grok");
    assert.equal(success.finishReason, "stop");
    assert.equal(lastAuth, "Bearer test-key");
    assert.equal(lastBody.model, "grok-test");
    assert.equal(lastBody.messages[0].content, "hello");
    assert.equal(lastBody.max_tokens, 800);
    assert.deepEqual(success.diagnostics && {
        current: success.diagnostics.current,
        max: success.diagnostics.max,
        min: success.diagnostics.min,
        successes: success.diagnostics.successes,
        failures: success.diagnostics.failures,
    }, {
        current: 2,
        max: 8,
        min: 1,
        successes: 1,
        failures: 0,
    });

    const customMaxTokens = await callGrokExec("hello", "grok-test", 1_000, 1234);
    assert.equal(customMaxTokens.text, "ok from grok");
    assert.equal(lastBody.max_tokens, 1234);

    mode = "empty";
    const empty = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(empty.text, null);
    assert.equal(empty.failureClass, "Quality");
    assert.match(empty.error || "", /输出为空/u);

    mode = "length";
    const truncated = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(truncated.text, null);
    assert.equal(truncated.finishReason, "length");
    assert.equal(truncated.failureClass, "Complexity");
    assert.match(truncated.error || "", /截断/u);

    mode = "length-empty";
    const truncatedEmpty = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(truncatedEmpty.text, null);
    assert.equal(truncatedEmpty.finishReason, "length");
    assert.equal(truncatedEmpty.failureClass, "Complexity");
    assert.match(truncatedEmpty.error || "", /截断/u);
    assert.doesNotMatch(truncatedEmpty.error || "", /输出为空/u);

    mode = "status-429";
    const limited = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(limited.text, null);
    assert.equal(limited.status, 429);
    assert.equal(limited.failureClass, "Congestion");
    assert.match(limited.error || "", /限流/u);

    mode = "status-502";
    const upstream = await callGrokExec("hello", "grok-test", 1_000);
    assert.equal(upstream.text, null);
    assert.equal(upstream.status, 502);
    assert.equal(upstream.failureClass, "Congestion");
    assert.match(upstream.error || "", /上游不可用/u);

    mode = "delay";
    const timeout = await callGrokExec("hello", "grok-test", 30);
    assert.equal(timeout.text, null);
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.failureClass, "Availability");
    assert.match(timeout.error || "", /超时/u);

    delete process.env.MEMORY_STORE_GROK_MODEL;
    delete process.env.MEMORY_STORE_GROK_RECORD_MODEL;
    delete process.env.MEMORY_STORE_GROK_GUARD_MODEL;
    delete process.env.MEMORY_STORE_GROK_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_RECORD_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_GUARD_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
    assert.equal(mapGrokModel("MODEL_PLACEHOLDER_M132"), "grok-4.20-0309-non-reasoning");
    assert.equal(mapGrokModel("grok-custom"), "grok-custom");
    assert.equal(mapGrokModel("MODEL_PLACEHOLDER_M132", "record"), "grok-4.3");
    assert.equal(mapGrokModel("MODEL_PLACEHOLDER_M132", "guard"), "grok-4.5");
    assert.equal(mapGrokMaxTokens("default"), 800);
    assert.equal(mapGrokMaxTokens("record"), 8192);
    assert.equal(mapGrokMaxTokens("guard"), 4096);
    process.env.MEMORY_STORE_GROK_MODEL = "grok-env-default";
    process.env.MEMORY_STORE_GROK_RECORD_MODEL = "grok-env-record";
    process.env.MEMORY_STORE_GROK_GUARD_MODEL = "grok-env-guard";
    process.env.MEMORY_STORE_GROK_MAX_TOKENS = "321";
    process.env.MEMORY_STORE_GROK_RECORD_MAX_TOKENS = "4321";
    process.env.MEMORY_STORE_GROK_GUARD_MAX_TOKENS = "5432";
    assert.equal(mapGrokModel("grok-custom"), "grok-env-default");
    assert.equal(mapGrokModel("anything", "record"), "grok-env-record");
    assert.equal(mapGrokModel("anything", "guard"), "grok-env-guard");
    assert.equal(mapGrokMaxTokens("default"), 321);
    assert.equal(mapGrokMaxTokens("record"), 4321);
    assert.equal(mapGrokMaxTokens("guard"), 5432);
    process.env.MEMORY_STORE_GROK_RECORD_MAX_TOKENS = "not-a-number";
    assert.equal(mapGrokMaxTokens("record"), 8192);
    process.env.MEMORY_STORE_GROK_RECORD_MAX_TOKENS = "4096abc";
    assert.equal(mapGrokMaxTokens("record"), 8192);

    for (const [rawValue, expectedMax, expectedCurrent] of [
        ["1", 1, 1],
        ["NaN", 8, 2],
        ["Infinity", 8, 2],
        ["2.9", 2, 2],
    ] as const) {
        process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = rawValue;
        resetGrokCallConcurrencyForTest();
        mode = "success";
        const result = await callGrokExec(`concurrency-${rawValue}`, "grok-test", 1_000);
        assert.equal(result.diagnostics?.max, expectedMax, `${rawValue} should resolve to the expected concurrency maximum`);
        assert.equal(result.diagnostics?.current, expectedCurrent, `${rawValue} should resolve to the expected initial concurrency`);
    }

    resetGrokBridgeAvailabilityForTest();
    modelsOk = true;
    assert.equal(await isGrokBridgeAvailable(), true);
    modelsOk = false;
    assert.equal(await isGrokBridgeAvailable(), true, "availability should use fresh TTL cache");
    resetGrokBridgeAvailabilityForTest();
    assert.equal(await isGrokBridgeAvailable(), false);
} finally {
    await resetProviderTransportAdapterForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    delete process.env.MEMORY_STORE_GROK_API_KEY;
    delete process.env.MEMORY_STORE_GROK_MODEL;
    delete process.env.MEMORY_STORE_GROK_RECORD_MODEL;
    delete process.env.MEMORY_STORE_GROK_GUARD_MODEL;
    delete process.env.MEMORY_STORE_GROK_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_RECORD_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_GUARD_MAX_TOKENS;
    delete process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
    resetGrokCallConcurrencyForTest();
    server.close();
}
