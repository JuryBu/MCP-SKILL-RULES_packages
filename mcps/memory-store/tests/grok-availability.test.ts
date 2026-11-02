import assert from "node:assert/strict";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { getGrokBridgeAvailabilityDiagnostics, isGrokBridgeAvailable, resetGrokBridgeAvailabilityForTest } from "../src/grok-client.ts";
import { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } from "../src/provider-transport-adapter.ts";
import type { ProviderAdmission, ProviderAdmissionOutcome, ProviderAdmissionSnapshot } from "../src/provider-admission.ts";

await test("Grok catalog preflight remains bounded, cancellable, and read-only", async suite => {
    const previousUrl = process.env.MEMORY_STORE_GROK_PROXY_URL;
    const previousTimeout = process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
    let responseDelayMs = 0;
    let admissionDelayMs = 0;
    let responseStatus = 200;
    let requestCount = 0;
    let generationCount = 0;
    const outcomes: ProviderAdmissionOutcome[] = [];
    const server = http.createServer(async (request, response) => {
        requestCount++;
        if (request.method !== "GET" || request.url !== "/v1/models") generationCount++;
        await delay(responseDelayMs);
        if (response.destroyed) return;
        response.writeHead(responseStatus, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "test-model" }] }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.equal(typeof address, "object");
    process.env.MEMORY_STORE_GROK_PROXY_URL = `http://127.0.0.1:${address!.port}`;
    const admission: Pick<ProviderAdmission, "acquire" | "snapshot"> = {
        async acquire(provider, trafficClass, invocation) {
            await delay(admissionDelayMs, undefined, { signal: invocation.signal });
            return {
                provider, trafficClass, attemptId: invocation.attemptId, leaseId: invocation.attemptId,
                ownerEpoch: 1, capacityGeneration: 1, leaseIdentity: null, receipt: null, probe: false,
                async complete(outcome) { outcomes.push(outcome); return true; },
                async markUnknownOutcome() { throw new Error("read-only catalog must not create an uncertain generation"); },
                async release() { return true; },
                async assertCurrent() {},
            };
        },
        async snapshot(provider): Promise<ProviderAdmissionSnapshot> {
            return { provider, mode: "test", queuedForeground: 0, queuedRecord: 0, active: 0, uncertain: 0,
                currentLimit: 2, effectiveLimit: 2, capacityGeneration: 1, lossEpoch: 0, frozen: false,
                breakerOpenUntilMs: null, shadowGrants: 0 };
        },
    };
    await configureProviderTransportAdapterForTest({ mode: "test", admission });
    const reset = () => {
        resetGrokBridgeAvailabilityForTest();
        responseDelayMs = 0;
        admissionDelayMs = 0;
        responseStatus = 200;
        delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
        outcomes.length = 0;
    };
    try {
        await suite.test("a healthy response beyond the former three-second budget succeeds", async () => {
            reset();
            admissionDelayMs = 80;
            responseDelayMs = 3_100;
            assert.equal(await isGrokBridgeAvailable(), true);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.timeoutMs, 10_000);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.status, 200);
            assert.deepEqual(outcomes.map(outcome => outcome.kind), ["success"]);
        });
        await suite.test("catalog timeout settles as availability, never an unknown generation", async () => {
            reset();
            process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "100";
            responseDelayMs = 250;
            assert.equal(await isGrokBridgeAvailable(), false);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "timeout");
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "transport");
            assert.deepEqual(outcomes.map(outcome => outcome.kind), ["availability"]);
        });
        await suite.test("admission wait consumes the same deadline without dispatch", async () => {
            reset();
            process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "50";
            admissionDelayMs = 200;
            const beforeRequests = requestCount;
            assert.equal(await isGrokBridgeAvailable(), false);
            assert.equal(requestCount, beforeRequests);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "admission");
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "timeout");
            assert.equal(outcomes.length, 0);
        });
        await suite.test("caller cancellation releases the probe without poisoning availability cache", async () => {
            reset();
            responseDelayMs = 250;
            const controller = new AbortController();
            const pending = isGrokBridgeAvailable({ signal: controller.signal });
            await delay(50);
            controller.abort();
            assert.equal(await pending, false);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "cancelled");
            assert.deepEqual(outcomes.map(outcome => outcome.kind), ["cancelled"]);
            responseDelayMs = 0;
            assert.equal(await isGrokBridgeAvailable(), true);
            const beforeRequests = requestCount;
            assert.equal(await isGrokBridgeAvailable({ signal: AbortSignal.abort() }), false);
            assert.equal(requestCount, beforeRequests);
        });
        await suite.test("negative catalog cache expires sooner than healthy cache", async () => {
            reset();
            responseStatus = 503;
            assert.equal(await isGrokBridgeAvailable(), false);
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "http");
            assert.equal(getGrokBridgeAvailabilityDiagnostics()?.status, 503);
            responseStatus = 200;
            const originalNow = Date.now;
            const beforeRequests = requestCount;
            try {
                Date.now = () => originalNow() + 5_001;
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(requestCount, beforeRequests + 1);
                Date.now = () => originalNow() + 6_001;
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(requestCount, beforeRequests + 1);
            } finally {
                Date.now = originalNow;
            }
        });
        await suite.test("invalid and excessive configured deadlines remain bounded", async () => {
            for (const [value, expected] of [["NaN", 10_000], ["0", 10_000], ["1e20", 60_000]] as const) {
                reset();
                process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = value;
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.timeoutMs, expected);
            }
        });
        assert.equal(generationCount, 0);
    } finally {
        await resetProviderTransportAdapterForTest();
        resetGrokBridgeAvailabilityForTest();
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        if (previousUrl === undefined) delete process.env.MEMORY_STORE_GROK_PROXY_URL;
        else process.env.MEMORY_STORE_GROK_PROXY_URL = previousUrl;
        if (previousTimeout === undefined) delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
        else process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = previousTimeout;
    }
});
