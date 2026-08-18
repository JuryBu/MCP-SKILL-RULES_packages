import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

type HoldRelease = () => void;
type ChatHandler = (context: {
    body: any;
    prompt: string;
    finishJson: (payload: unknown, status?: number) => void;
    holdJson: (payload: unknown, status?: number) => void;
    destroy: () => void;
}) => void;

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 1_000, intervalMs = 10): Promise<void> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        if (await predicate()) return;
        await sleep(intervalMs);
    }
    throw new Error(`waitFor timeout after ${timeoutMs}ms`);
}

function createHarness() {
    const handlers: ChatHandler[] = [];
    const holds: HoldRelease[] = [];
    const prompts: string[] = [];
    let active = 0;
    let maxActive = 0;
    let requestCount = 0;

    const server = http.createServer((req, res) => {
        if (req.url === "/v1/models" && req.method === "GET") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ data: [{ id: "grok-bridge" }] }));
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
            active += 1;
            maxActive = Math.max(maxActive, active);
            requestCount += 1;

            let finalized = false;
            const finalize = () => {
                if (finalized) return;
                finalized = true;
                active = Math.max(0, active - 1);
            };
            res.on("close", finalize);

            const body = raw ? JSON.parse(raw) : {};
            const prompt = String(body?.messages?.[0]?.content || "");
            prompts.push(prompt);

            const finishJson = (payload: unknown, status = 200) => {
                if (!res.writableEnded && !res.destroyed) {
                    res.writeHead(status, { "content-type": "application/json" });
                    res.end(JSON.stringify(payload));
                }
                finalize();
            };

            const holdJson = (payload: unknown, status = 200) => {
                holds.push(() => finishJson(payload, status));
            };

            const destroy = () => {
                if (!res.destroyed) res.destroy();
                finalize();
            };

            const handler = handlers.shift();
            if (handler) {
                handler({ body, prompt, finishJson, holdJson, destroy });
                return;
            }

            finishJson({ choices: [{ message: { content: `ok:${prompt}` }, finish_reason: "stop" }] });
        });
    });

    return {
        handlers,
        prompts,
        stats: () => ({ active, maxActive, requestCount, holdCount: holds.length }),
        releaseNextHold: () => {
            const release = holds.shift();
            assert.ok(release, "expected a held response to release");
            release();
        },
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
        listen: async () => {
            await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
            const address = server.address();
            assert.equal(typeof address, "object");
            return `http://127.0.0.1:${address!.port}`;
        },
    };
}

const harness = createHarness();
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-grok-concurrency-"));
const dataRoot = path.join(tempRoot, "data");
const previousDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
const previousProxyUrl = process.env.MEMORY_STORE_GROK_PROXY_URL;
const previousApiKey = process.env.MEMORY_STORE_GROK_API_KEY;
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_GROK_PROXY_URL = await harness.listen();
process.env.MEMORY_STORE_GROK_API_KEY = "test-key";

try {
    const { callGrokExec } = await import("../src/grok-client.ts");
    const { initializeProviderControlStore } = await import("../src/provider-control-store.ts");
    const { configureProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");

    await initializeProviderControlStore({ dataRoot, initialization: "exclusive-install" });
    const adapter = await configureProviderTransportAdapterForTest({
        mode: "enforced",
        dataRoot,
        ownerId: "grok-concurrency-test",
    });

    for (let index = 0; index < 3; index += 1) {
        harness.handlers.push(({ prompt, holdJson }) => {
            holdJson({ choices: [{ message: { content: `done:${prompt}` }, finish_reason: "stop" }] });
        });
    }

    const requestCountBefore = harness.stats().requestCount;
    const first = callGrokExec("holder-one", "grok-control", 2_000, 128, { context: "default" });
    const second = callGrokExec("holder-two", "grok-control", 2_000, 128, { context: "record" });

    await waitFor(() => harness.stats().requestCount === requestCountBefore + 2);
    const saturated = await adapter.admissionSnapshot("grok");
    if (saturated.currentLimit === null || saturated.effectiveLimit === null) {
        throw new Error("enforced Grok provider control did not expose its active limit");
    }
    const controlLimit = saturated.currentLimit;
    assert.equal(controlLimit, 2, "fresh provider control must start from its initial physical limit");
    assert.equal(saturated.effectiveLimit, controlLimit, "Grok effective limit must come from provider control");
    assert.equal(saturated.active, controlLimit, "provider control should account for every physical Grok POST");
    assert.equal(harness.stats().active, saturated.active, "fake transport active POST count must match provider control");

    const queued = callGrokExec("legacy-queue-timeout", "grok-control", 2_000, 128, {
        context: "guard",
        queueTimeoutMs: 10,
    });
    await waitFor(async () => (await adapter.admissionSnapshot("grok")).queuedForeground === 1);
    await sleep(80);

    const whileQueued = await adapter.admissionSnapshot("grok");
    assert.equal(whileQueued.queuedForeground, 1, "legacy queueTimeoutMs must not terminate provider permit waiting");
    assert.equal(harness.stats().requestCount, requestCountBefore + 2, "waiting for a provider permit must not start an extra HTTP POST");
    assert.equal(harness.prompts.includes("legacy-queue-timeout"), false, "the queued request must not reach the transport before its permit");
    assert.ok(whileQueued.effectiveLimit !== null && whileQueued.active <= whileQueued.effectiveLimit, "physical Grok activity must stay within the provider control limit");
    assert.ok(harness.stats().maxActive <= controlLimit, "observed physical POST peak must not exceed the control limit");

    harness.releaseNextHold();
    await waitFor(() => harness.stats().requestCount === requestCountBefore + 3);
    const afterPermit = await adapter.admissionSnapshot("grok");
    assert.ok(afterPermit.effectiveLimit !== null && afterPermit.active <= afterPermit.effectiveLimit, "the post-permit transport activity must remain controlled");

    while (harness.stats().holdCount > 0) harness.releaseNextHold();
    const [firstResult, secondResult, queuedResult] = await Promise.all([first, second, queued]);
    assert.equal(firstResult.text, "done:holder-one");
    assert.equal(secondResult.text, "done:holder-two");
    assert.equal(queuedResult.text, "done:legacy-queue-timeout", "the legacy queue timeout option must not fail a permit-waiting request");
    assert.notEqual(queuedResult.timedOut, true);

    const drained = await adapter.admissionSnapshot("grok");
    assert.equal(drained.active, 0, "all physical Grok permits must settle after their POSTs finish");
    assert.equal(drained.queuedForeground, 0, "provider queue must drain after permits are released");
} finally {
    while (harness.stats().holdCount > 0) harness.releaseNextHold();
    const { resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
    await resetProviderTransportAdapterForTest();
    if (previousDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = previousDataRoot;
    if (previousProxyUrl === undefined) delete process.env.MEMORY_STORE_GROK_PROXY_URL;
    else process.env.MEMORY_STORE_GROK_PROXY_URL = previousProxyUrl;
    if (previousApiKey === undefined) delete process.env.MEMORY_STORE_GROK_API_KEY;
    else process.env.MEMORY_STORE_GROK_API_KEY = previousApiKey;
    await harness.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
}

console.log("grok-concurrency tests passed");
