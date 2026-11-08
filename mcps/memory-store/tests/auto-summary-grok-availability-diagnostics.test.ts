import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { ProviderAdmission, ProviderAdmissionSnapshot } from "../src/provider-admission.ts";
import type { ModelBridgeResult } from "../src/model-bridge.ts";
import type { GrokAvailabilityDiagnostics } from "../src/grok-client.ts";

await test("auto-summary retains only its own Grok availability diagnostics without network dispatch", async suite => {
    const keys = ["MEMORY_STORE_DATA_ROOT", "MEMORY_STORE_GROK_PROXY_URL", "MEMORY_STORE_GROK_API_KEY", "MEMORY_STORE_GROK_STATUS_TIMEOUT_MS"] as const;
    const environment = new Map(keys.map(key => [key, process.env[key]]));
    process.env.MEMORY_STORE_DATA_ROOT = path.join(os.tmpdir(), `availability-diagnostics-unused-${process.pid}`);
    process.env.MEMORY_STORE_GROK_PROXY_URL = "https://fixture.invalid";
    process.env.MEMORY_STORE_GROK_API_KEY = "fixture-secret";
    delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
    const grok = await import("../src/grok-client.ts");
    const bridge = await import("../src/model-bridge.ts");
    const summary = await import("../src/auto-summary.ts");
    const transport = await import("../src/provider-transport-adapter.ts");
    const originalFetch = globalThis.fetch;
    let fetchCount = 0;
    let generationCount = 0;
    let admissionError: Error | undefined;
    let respond: typeof fetch = async () => new Response("private response body", { status: 503 });
    globalThis.fetch = async (input, options) => {
        fetchCount++;
        const target = new URL(String(input));
        if (target.origin !== "https://fixture.invalid" || target.pathname !== "/v1/models" || options?.method !== "GET") {
            generationCount++;
            throw new Error("unexpected fixture dispatch");
        }
        return await respond(input, options);
    };
    const admission: Pick<ProviderAdmission, "acquire" | "snapshot"> = {
        async acquire(provider, trafficClass, invocation) {
            if (admissionError) throw admissionError;
            return {
                provider, trafficClass, attemptId: invocation.attemptId, leaseId: invocation.attemptId,
                ownerEpoch: 1, capacityGeneration: 1, leaseIdentity: null, receipt: null, probe: false,
                async complete() { return true; },
                async markUnknownOutcome() { assert.fail("catalog must not create an uncertain generation"); },
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
    await transport.configureProviderTransportAdapterForTest({ mode: "test", admission });
    const call = (options: Parameters<typeof bridge.callModelResponse>[4] = {}, timeout = 2000) =>
        bridge.callModelResponse("fixture-model", "fixture input", "grok", timeout, options);
    const provenance = async (result: ModelBridgeResult) => (await summary.generateAutoSummaryResult("fixture", [], "fixture body", "grok", { callModel: async () => result })).provenance;
    const reset = () => {
        grok.resetGrokBridgeAvailabilityForTest();
        admissionError = undefined;
        delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
    };
    const waitFor = async (predicate: () => boolean) => {
        for (let attempt = 0; attempt < 200 && !predicate(); attempt++) await delay(1);
        assert.ok(predicate(), "fixture check did not start");
    };
    const heldResponse: typeof fetch = async (_input, options) => new Promise((_resolve, reject) => {
        const signal = options!.signal!;
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    try {
        await suite.test("HTTP failure reaches serialized provenance without sensitive response data", async () => {
            reset();
            const result = await call();
            const record = await provenance(result);
            assert.equal(record.status, "failed");
            assert.equal(record.provider, null);
            assert.equal(record.model, null);
            assert.equal(record.failureClass, "Availability");
            assert.equal(record.failures[0]?.reason, "Grok 模型桥不可用或 progrok proxy 不可用");
            const diagnostics = record.grokAvailabilityDiagnostics!;
            assert.equal(diagnostics.failure, "http");
            assert.equal(diagnostics.phase, "complete");
            assert.equal(diagnostics.status, 503);
            assert.equal(diagnostics.timeoutMs, 10000);
            assert.equal(diagnostics.cacheHit, false);
            assert.ok(diagnostics.checkedAtMs > 0 && diagnostics.durationMs >= 0);
            const serialized = JSON.stringify(record);
            assert.doesNotMatch(serialized, /fixture\.invalid|fixture-secret|private response body/u);
            assert.deepEqual(JSON.parse(serialized).grokAvailabilityDiagnostics, diagnostics);
        });
        await suite.test("connection error retains only the safe code", async () => {
            reset();
            respond = async () => { throw Object.assign(new Error("fixture-secret https://fixture.invalid"), { cause: { code: "ECONNREFUSED" } }); };
            const record = await provenance(await call());
            assert.equal(record.grokAvailabilityDiagnostics?.failure, "transport");
            assert.equal(record.grokAvailabilityDiagnostics?.phase, "transport");
            assert.equal(record.grokAvailabilityDiagnostics?.errorCode, "ECONNREFUSED");
            assert.doesNotMatch(JSON.stringify(record), /fixture-secret|fixture\.invalid/u);
        });
        await suite.test("concurrent reversed completion never replaces another call's diagnosis", async () => {
            reset();
            const releases: Array<(response: Response) => void> = [];
            respond = async () => new Promise(resolve => { releases.push(resolve); });
            const first = call();
            await waitFor(() => releases.length === 1);
            const second = call();
            await waitFor(() => releases.length === 2);
            releases[1](new Response(null, { status: 502 }));
            const secondResult = await second;
            releases[0](new Response(null, { status: 503 }));
            const firstResult = await first;
            assert.equal(grok.getGrokBridgeAvailabilityDiagnostics()?.status, 503);
            assert.equal((await provenance(secondResult)).grokAvailabilityDiagnostics?.status, 502);
            assert.equal((await provenance(firstResult)).grokAvailabilityDiagnostics?.status, 503);
        });
        await suite.test("cancelled concurrent check cannot replace cached failure identity", async () => {
            reset();
            const before = fetchCount;
            let started = false;
            respond = async (...args) => { started = true; return heldResponse(...args); };
            const controller = new AbortController();
            const cancelled = call({ signal: controller.signal });
            await waitFor(() => started);
            respond = async () => new Response(null, { status: 503 });
            const original = await call();
            controller.abort();
            const cancelledResult = await cancelled;
            assert.equal(cancelledResult.grokAvailabilityDiagnostics?.failure, "cancelled");
            await waitFor(() => grok.getGrokBridgeAvailabilityDiagnostics()?.failure === "cancelled");
            const cached = await call();
            assert.equal(fetchCount, before + 2);
            assert.equal(cached.grokAvailabilityDiagnostics?.cacheHit, true);
            assert.equal(cached.grokAvailabilityDiagnostics?.failure, "http");
            assert.equal(cached.grokAvailabilityDiagnostics?.status, 503);
            assert.equal(cached.grokAvailabilityDiagnostics?.checkedAtMs, original.grokAvailabilityDiagnostics?.checkedAtMs);
            assert.equal(cached.grokAvailabilityDiagnostics?.durationMs, original.grokAvailabilityDiagnostics?.durationMs);
        });
        await suite.test("catalog timeout retains phase and original timeout without changing classification", async () => {
            reset();
            process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "20";
            respond = heldResponse;
            const keepAlive = setTimeout(() => {}, 1000);
            try {
                const record = await provenance(await call());
                assert.equal(record.failureClass, "Availability");
                assert.equal(record.grokAvailabilityDiagnostics?.failure, "timeout");
                assert.equal(record.grokAvailabilityDiagnostics?.phase, "transport");
                assert.equal(record.grokAvailabilityDiagnostics?.timeoutMs, 20);
            } finally { clearTimeout(keepAlive); }
        });
        await suite.test("admission failure does not dispatch and retains its safe code", async () => {
            reset();
            admissionError = Object.assign(new Error("fixture-secret"), { code: "EACCES" });
            const before = fetchCount;
            const record = await provenance(await call());
            assert.equal(fetchCount, before);
            assert.equal(record.grokAvailabilityDiagnostics?.phase, "admission");
            assert.equal(record.grokAvailabilityDiagnostics?.failure, "admission");
            assert.equal(record.grokAvailabilityDiagnostics?.errorCode, "EACCES");
        });
        await suite.test("unsafe error codes and missing checks remain absent", async () => {
            reset();
            respond = async () => { throw Object.assign(new Error("fixture-secret"), { code: "https://fixture.invalid/fixture-secret" }); };
            const record = await provenance(await call());
            assert.equal(record.grokAvailabilityDiagnostics?.errorCode, undefined);
            assert.doesNotMatch(JSON.stringify(record), /fixture-secret|fixture\.invalid/u);
            const noCheck = await provenance({ text: null, chainUsed: null, error: "fixture failure", failureClass: "Availability" });
            assert.equal(noCheck.grokAvailabilityDiagnostics, undefined);
        });
        await suite.test("negative five-second and positive sixty-second cache policies remain unchanged", async () => {
            reset();
            const originalNow = Date.now;
            const baselineNow = originalNow();
            const before = fetchCount;
            const captured: GrokAvailabilityDiagnostics[] = [];
            try {
                Date.now = () => baselineNow;
                respond = async () => new Response(null, { status: 503 });
                assert.equal(await grok.isGrokBridgeAvailable(), false);
                respond = async () => new Response(null, { status: 200 });
                Date.now = () => baselineNow + 4999;
                assert.equal(await grok.isGrokBridgeAvailable(), false);
                assert.equal(fetchCount, before + 1);
                Date.now = () => baselineNow + 5001;
                assert.equal(await grok.isGrokBridgeAvailable(), true);
                assert.equal(fetchCount, before + 2);
                Date.now = () => baselineNow + 64000;
                assert.equal(await grok.isGrokBridgeAvailable({ onDiagnostics: value => captured.push(value) }), true);
                assert.equal(fetchCount, before + 2);
                assert.equal(captured[0]?.cacheHit, true);
                Date.now = () => baselineNow + 66001;
                assert.equal(await grok.isGrokBridgeAvailable(), true);
                assert.equal(fetchCount, before + 3);
            } finally { Date.now = originalNow; }
        });
        await suite.test("total deadline retains this check's abort snapshot before late settlement", async () => {
            reset();
            respond = heldResponse;
            const result = await call({}, 20);
            assert.equal(result.timedOut, true);
            assert.equal(result.failureClass, "Availability");
            assert.equal(result.grokAvailabilityDiagnostics?.failure, "cancelled");
            assert.equal(result.grokAvailabilityDiagnostics?.phase, "transport");
            assert.equal((await provenance(result)).grokAvailabilityDiagnostics?.cacheHit, false);
        });
        await suite.test("pre-aborted check reports its own cancellation without a probe", async () => {
            reset();
            const before = fetchCount;
            let captured: GrokAvailabilityDiagnostics | undefined;
            assert.equal(await grok.isGrokBridgeAvailable({ signal: AbortSignal.abort(), onDiagnostics: value => { captured = value; } }), false);
            assert.equal(fetchCount, before);
            assert.equal(captured?.failure, "cancelled");
            assert.equal(captured?.phase, "admission");
            assert.equal(captured?.status, undefined);
        });
        assert.equal(generationCount, 0);
        console.log(`EVIDENCE fixture-only fetches=${fetchCount}; generation dispatches=${generationCount}; diagnostics isolated across concurrent calls and cache`);
    } finally {
        globalThis.fetch = originalFetch;
        await transport.resetProviderTransportAdapterForTest();
        grok.resetGrokBridgeAvailabilityForTest();
        for (const key of keys) {
            const value = environment.get(key);
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
});
