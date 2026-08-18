import assert from "node:assert/strict";
import http from "node:http";

type Mode = "success" | "empty" | "length-empty" | "malformed" | "partial-body" | "status-400" | "status-429" | "status-500" | "status-502" | "delay" | "network" | "hold";

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
    const startedAt = Date.now();
    while (!predicate()) {
        if (Date.now() - startedAt >= timeoutMs) throw new Error(`waitFor timeout after ${timeoutMs}ms`);
        await sleep(5);
    }
}

let mode: Mode = "success";
let requestCount = 0;
let releaseHold: (() => void) | undefined;

const server = http.createServer((req, res) => {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404);
        res.end("not found");
        return;
    }

    req.resume();
    req.on("end", () => {
        requestCount += 1;
        if (mode === "network") {
            res.destroy();
            return;
        }
        if (mode === "delay") {
            setTimeout(() => {
                if (!res.destroyed) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { content: "late" }, finish_reason: "stop" }] }));
                }
            }, 150);
            return;
        }
        if (mode === "hold") {
            releaseHold = () => {
                if (!res.destroyed) {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ choices: [{ message: { content: "released" }, finish_reason: "stop" }] }));
                }
            };
            return;
        }
        if (mode === "status-400" || mode === "status-429" || mode === "status-500" || mode === "status-502") {
            const status = Number(mode.slice("status-".length));
            res.writeHead(status, { "content-type": "text/plain" });
            res.end(`status ${status}`);
            return;
        }
        if (mode === "empty" || mode === "length-empty") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({
                choices: [{
                    message: { content: "" },
                    finish_reason: mode === "length-empty" ? "length" : "stop",
                }],
            }));
            return;
        }
        if (mode === "malformed") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end("{not-json");
            return;
        }
        if (mode === "partial-body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.flushHeaders();
            res.write('{"choices":[{"message":{"content":"partial"');
            setTimeout(() => res.socket?.destroy(), 20);
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
    });
});

await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.equal(typeof address, "object");
process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address!.port}`;
process.env.MEMORY_STORE_GROK_API_KEY = "test-key";

const { callGrokExec, resetGrokCallConcurrencyForTest } = await import("../src/grok-client.ts");
const {
    configureProviderTransportAdapterForTest,
    resetProviderTransportAdapterForTest,
} = await import("../src/provider-transport-adapter.ts");
await configureProviderTransportAdapterForTest({ mode: "shadow" });

function resetWindow(max = 4): void {
    process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY = String(max);
    resetGrokCallConcurrencyForTest();
}

async function callForMode(nextMode: Exclude<Mode, "hold">, timeoutMs = 500) {
    resetWindow();
    mode = nextMode;
    return callGrokExec(`classification-${nextMode}`, "grok-classification", timeoutMs);
}

try {
    const limited = await callForMode("status-429");
    assert.equal(limited.status, 429);
    assert.deepEqual(limited.diagnostics && {
        current: limited.diagnostics.current,
        failures: limited.diagnostics.failures,
        successes: limited.diagnostics.successes,
    }, { current: 1, failures: 1, successes: 0 });

    for (const statusMode of ["status-500", "status-502"] as const) {
        const result = await callForMode(statusMode);
        assert.ok((result.status || 0) >= 500);
        assert.equal(result.diagnostics?.current, 1, `${statusMode} should halve the window`);
        assert.equal(result.diagnostics?.failures, 1, `${statusMode} should count as a transport failure`);
    }

    const timedOut = await callForMode("delay", 30);
    assert.equal(timedOut.timedOut, true);
    assert.equal(timedOut.diagnostics?.current, 1, "actual fetch timeout should halve the window");
    assert.equal(timedOut.diagnostics?.failures, 1);

    const network = await callForMode("network");
    assert.match(network.error || "", /调用失败/u);
    assert.equal(network.diagnostics?.current, 1, "fetch rejection before a Response should halve the window");
    assert.equal(network.diagnostics?.failures, 1);

    const partialBody = await callForMode("partial-body");
    assert.match(partialBody.error || "", /调用失败/u);
    assert.equal(partialBody.diagnostics?.current, 1, "a socket disconnect during a received response body should halve the window");
    assert.equal(partialBody.diagnostics?.failures, 1, "an incomplete response body must count as a network failure");

    const malformed = await callForMode("malformed");
    assert.match(malformed.error || "", /调用失败/u);
    assert.equal(malformed.diagnostics?.current, 2, "a complete malformed JSON body must not change the window");
    assert.equal(malformed.diagnostics?.failures, 0, "a complete malformed JSON body must remain unknown");

    for (const nonCongestionMode of ["empty", "length-empty", "status-400"] as const) {
        const result = await callForMode(nonCongestionMode);
        assert.equal(result.diagnostics?.current, 2, `${nonCongestionMode} must not change the window`);
        assert.equal(result.diagnostics?.failures, 0, `${nonCongestionMode} must not count as a transport failure`);
    }

    resetWindow(1);
    mode = "hold";
    let cancelled = false;
    const requestCountBeforeCancel = requestCount;
    const cancelledCall = callGrokExec("cancelled-during-transport", "grok-classification", 500, 128, {
        shouldCancel: () => cancelled,
    });
    await waitFor(() => requestCount > 0 && releaseHold !== undefined);
    await sleep(30);
    cancelled = true;
    const cancelledResult = await cancelledCall;
    assert.equal(cancelledResult.cancelled, true);
    assert.equal(cancelledResult.diagnostics?.failures, 0, "transport cancellation must not count as a transport failure");
    assert.equal(requestCount, requestCountBeforeCancel + 1, "transport cancellation should abort the single started fetch");
    releaseHold?.();
} finally {
    await resetProviderTransportAdapterForTest();
    delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    delete process.env.MEMORY_STORE_GROK_API_KEY;
    delete process.env.MEMORY_STORE_GROK_CALL_CONCURRENCY;
    await new Promise<void>(resolve => server.close(() => resolve()));
}

console.log("concurrency failure classification tests passed");
