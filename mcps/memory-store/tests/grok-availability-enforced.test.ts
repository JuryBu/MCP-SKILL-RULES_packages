import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { AddressInfo } from "node:net";
import type { ProviderTransportLease } from "../src/provider-transport-adapter.ts";

const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "grok-availability-enforced-"));
const unusedDefaultRoot = path.join(tempRoot, "must-remain-unused");
const environmentKeys = ["MEMORY_STORE_DATA_ROOT", "MEMORY_STORE_GROK_PROXY_URL", "MEMORY_STORE_GROK_API_KEY", "MEMORY_STORE_GROK_STATUS_TIMEOUT_MS"] as const;
const previousEnvironment = new Map(environmentKeys.map(key => [key, process.env[key]]));
process.env.MEMORY_STORE_DATA_ROOT = unusedDefaultRoot;
process.env.MEMORY_STORE_GROK_API_KEY = "isolated-catalog-test-key";
delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;

const { isGrokBridgeAvailable, getGrokBridgeAvailabilityDiagnostics, resetGrokBridgeAvailabilityForTest } = await import("../src/grok-client.ts");
const { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } = await import("../src/provider-transport-adapter.ts");
const { readProviderControlStore } = await import("../src/provider-control-store.ts");
const { DATA_ROOT } = await import("../src/store.ts");
const originalFetch = globalThis.fetch;
const allowedOrigins = new Set<string>();
let generationCalls = 0;
let disallowedFetches = 0;

globalThis.fetch = async (input, options) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const method = options?.method ?? (input instanceof Request ? input.method : "GET");
    if (!allowedOrigins.has(target.origin) || target.pathname !== "/v1/models" || target.search || method !== "GET") {
        disallowedFetches++;
        throw new Error(`Blocked non-catalog test dispatch: ${method} ${target.origin}${target.pathname}`);
    }
    return await originalFetch(input, options);
};

async function waitFor(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
    const deadline = performance.now() + 3_000;
    while (performance.now() < deadline) {
        if (await predicate()) return;
        await delay(10);
    }
    assert.fail(message);
}

async function createFixture(label: string) {
    const dataRoot = await fs.mkdtemp(path.join(tempRoot, `${label}-`));
    const ownerId = `grok-availability-${label}`;
    let responseMode: "healthy" | "hold" | "partial-body" = "healthy";
    let requestCount = 0;
    const server = http.createServer((request, response) => {
        request.resume();
        requestCount++;
        if (request.method !== "GET" || request.url !== "/v1/models") {
            generationCalls++;
            response.writeHead(405);
            response.end();
            return;
        }
        if (responseMode === "hold") return;
        response.writeHead(200, { "content-type": "application/json" });
        if (responseMode === "partial-body") {
            response.flushHeaders();
            response.write('{"data":[');
            return;
        }
        response.end('{"data":[{"id":"catalog-only"}]}');
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    allowedOrigins.add(origin);
    process.env.MEMORY_STORE_GROK_PROXY_URL = origin;
    delete process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS;
    const adapter = await configureProviderTransportAdapterForTest({ mode: "test", dataRoot, ownerId });
    resetGrokBridgeAvailabilityForTest();

    async function readState() {
        const read = await readProviderControlStore({ dataRoot });
        assert.equal(read.kind, "current");
        if (read.kind !== "current") assert.fail(JSON.stringify(read));
        assert.equal(read.state.ownerLease?.ownerId, ownerId);
        return read.state;
    }

    async function assertClean() {
        const state = await readState();
        assert.equal(state.dispatchBlocked, false);
        assert.equal(state.repairRequired, false);
        for (const provider of ["grok", "agy"] as const) {
            assert.deepEqual(state.pools[provider].activeLeases, []);
            assert.deepEqual(state.pools[provider].uncertainLeases, []);
            assert.equal(state.pools[provider].breaker.probeLease, null);
            assert.equal(state.pools[provider].timeFrozen.frozen, false);
        }
        const snapshot = await adapter.admissionSnapshot("grok");
        assert.equal(snapshot.active, 0);
        assert.equal(snapshot.uncertain, 0);
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.queuedRecord, 0);
        assert.equal(adapter.diagnostics().settleFailureCount, 0);
        return state;
    }

    async function evidence(checkpoint: string) {
        const state = await assertClean();
        return {
            checkpoint, dataRoot, ownerEpoch: state.ownerEpoch, ownerId: state.ownerLease?.ownerId,
            dispatchBlocked: state.dispatchBlocked, repairRequired: state.repairRequired,
            activeLeases: state.pools.grok.activeLeases, uncertainLeases: state.pools.grok.uncertainLeases,
            lossEpoch: state.pools.grok.lossEpoch, breaker: state.pools.grok.breaker,
            frozen: state.pools.grok.timeFrozen.frozen,
            catalogRequests: requestCount,
            settlements: adapter.diagnostics().attempts.map(attempt => ({ kind: attempt.settlement, settled: attempt.permitSettled })),
            availability: getGrokBridgeAvailabilityDiagnostics(),
        };
    }

    async function warm() {
        assert.equal(await isGrokBridgeAvailable(), true);
        const state = await assertClean();
        assert.equal(state.ownerEpoch, 1);
        assert.equal(state.pools.grok.breaker.openUntilMs, null);
        assert.equal(adapter.diagnostics().attempts.at(-1)?.settlement, "success");
        resetGrokBridgeAvailabilityForTest();
        return state;
    }

    return {
        adapter, readState, assertClean, evidence, warm,
        requestCount: () => requestCount,
        setMode(mode: typeof responseMode) { responseMode = mode; },
        async close() {
            try {
                await resetProviderTransportAdapterForTest();
            } finally {
                server.closeAllConnections();
                await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
                allowedOrigins.delete(origin);
                resetGrokBridgeAvailabilityForTest();
            }
        },
    };
}

try {
    await test("Grok catalog preflight with real persisted provider admission", async suite => {
        assert.equal(DATA_ROOT, unusedDefaultRoot);

        await suite.test("warm owner: timeout leaves no UNKNOWN; five-second negative cache expires without resetting provider state", { timeout: 15_000 }, async context => {
            const fixture = await createFixture("timeout");
            try {
                const warm = await fixture.warm();
                fixture.setMode("hold");
                process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "750";
                const pending = isGrokBridgeAvailable();
                await waitFor(() => fixture.requestCount() === 2, "timeout probe must reach the fake HTTP server");
                assert.equal((await fixture.adapter.admissionSnapshot("grok")).active, 1);
                assert.equal(await pending, false);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "timeout");
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "transport");
                const failed = await fixture.assertClean();
                assert.equal(failed.ownerEpoch, warm.ownerEpoch);
                assert.equal(failed.ownerLease?.leaseId, warm.ownerLease?.leaseId);
                assert.equal(failed.pools.grok.lossEpoch, warm.pools.grok.lossEpoch);
                assert.equal(failed.pools.grok.breaker.openUntilMs, null);
                assert.equal(failed.pools.grok.breaker.consecutiveFailures, 1);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-transport-timeout")));
                fixture.setMode("healthy");
                const acquired = fixture.adapter.diagnostics().acquireCount;
                assert.equal(await isGrokBridgeAvailable(), false);
                assert.equal(fixture.requestCount(), 2);
                assert.equal(fixture.adapter.diagnostics().acquireCount, acquired);
                const checkedAt = getGrokBridgeAvailabilityDiagnostics()!.checkedAtMs;
                await delay(Math.max(0, checkedAt + 5_050 - Date.now()));
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(fixture.requestCount(), 3);
                assert.deepEqual(fixture.adapter.diagnostics().attempts.map(attempt => attempt.settlement), ["success", "availability", "success"]);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-negative-cache-recovery")));
            } finally {
                await fixture.close();
            }
        });

        await suite.test("warm owner: parent cancellation during HTTP releases the lease and permits immediate healthy retry", { timeout: 8_000 }, async context => {
            const fixture = await createFixture("parent-cancel");
            try {
                const warm = await fixture.warm();
                fixture.setMode("hold");
                const controller = new AbortController();
                const pending = isGrokBridgeAvailable({ signal: controller.signal });
                await waitFor(() => fixture.requestCount() === 2, "cancelled probe must reach the fake HTTP server");
                assert.equal((await fixture.adapter.admissionSnapshot("grok")).active, 1);
                controller.abort(new Error("isolated parent cancellation"));
                assert.equal(await pending, false);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "cancelled");
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "transport");
                const cancelled = await fixture.assertClean();
                assert.equal(cancelled.ownerLease?.leaseId, warm.ownerLease?.leaseId);
                assert.deepEqual(cancelled.pools.grok.breaker, warm.pools.grok.breaker);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-parent-cancellation")));
                fixture.setMode("healthy");
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(fixture.requestCount(), 3);
                const requests = fixture.requestCount();
                const acquisitions = fixture.adapter.diagnostics().acquireCount;
                assert.equal(await isGrokBridgeAvailable({ signal: AbortSignal.abort() }), false);
                assert.equal(fixture.requestCount(), requests);
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(fixture.adapter.diagnostics().acquireCount, acquisitions);
                assert.deepEqual(fixture.adapter.diagnostics().attempts.map(attempt => attempt.settlement), ["success", "cancelled", "success"]);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-immediate-cancel-recovery")));
            } finally {
                await fixture.close();
            }
        });

        await suite.test("warm owner: an incomplete catalog body times out as availability, with no uncertain generation", { timeout: 8_000 }, async context => {
            const fixture = await createFixture("partial-body");
            try {
                await fixture.warm();
                fixture.setMode("partial-body");
                process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "750";
                assert.equal(await isGrokBridgeAvailable(), false);
                assert.equal(fixture.requestCount(), 2);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "transport");
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "timeout");
                assert.deepEqual(fixture.adapter.diagnostics().attempts.map(attempt => attempt.settlement), ["success", "availability"]);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-catalog-body-timeout")));
            } finally {
                await fixture.close();
            }
        });

        await suite.test("warm owner: cancellation in the real admission queue dispatches no HTTP and leaves later requests unblocked", { timeout: 8_000 }, async context => {
            const fixture = await createFixture("queued-cancel");
            const leases: ProviderTransportLease[] = [];
            try {
                const warm = await fixture.warm();
                for (let slot = 0; slot < warm.pools.grok.currentLimit; slot++) {
                    leases.push(await fixture.adapter.acquire("grok", { attemptId: `catalog-queue-holder-${slot}` }));
                }
                const controller = new AbortController();
                const pending = isGrokBridgeAvailable({ signal: controller.signal });
                await waitFor(async () => (await fixture.adapter.admissionSnapshot("grok")).queuedForeground === 1, "catalog must enter the real provider queue");
                controller.abort(new Error("isolated queued cancellation"));
                assert.equal(await pending, false);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "cancelled");
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "admission");
                assert.equal(fixture.requestCount(), 1);
                assert.equal((await fixture.adapter.admissionSnapshot("grok")).queuedForeground, 0);
                for (const lease of leases.splice(0)) assert.equal(await fixture.adapter.release(lease), true);
                await fixture.assertClean();
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(fixture.requestCount(), 2);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-queued-cancel-recovery")));
            } finally {
                for (const lease of leases) await fixture.adapter.release(lease);
                await fixture.close();
            }
        });

        await suite.test("warm owner: an expired admission deadline removes the queued probe before capacity is released", { timeout: 8_000 }, async context => {
            const fixture = await createFixture("queued-timeout");
            const leases: ProviderTransportLease[] = [];
            try {
                const warm = await fixture.warm();
                for (let slot = 0; slot < warm.pools.grok.currentLimit; slot++) {
                    leases.push(await fixture.adapter.acquire("grok", { attemptId: `catalog-timeout-holder-${slot}` }));
                }
                process.env.MEMORY_STORE_GROK_STATUS_TIMEOUT_MS = "750";
                const pending = isGrokBridgeAvailable();
                await waitFor(async () => (await fixture.adapter.admissionSnapshot("grok")).queuedForeground === 1, "deadline probe must enter the real provider queue");
                assert.equal(await pending, false);
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.failure, "timeout");
                assert.equal(getGrokBridgeAvailabilityDiagnostics()?.phase, "admission");
                assert.equal(fixture.requestCount(), 1);
                assert.equal((await fixture.adapter.admissionSnapshot("grok")).queuedForeground, 0);
                for (const lease of leases.splice(0)) assert.equal(await fixture.adapter.release(lease), true);
                const expired = await fixture.assertClean();
                assert.deepEqual(expired.pools.grok.breaker, warm.pools.grok.breaker);
                assert.equal(fixture.adapter.diagnostics().attempts.length, 1 + warm.pools.grok.currentLimit);
                context.diagnostic(JSON.stringify(await fixture.evidence("after-queued-deadline-expiry")));
                resetGrokBridgeAvailabilityForTest();
                assert.equal(await isGrokBridgeAvailable(), true);
                assert.equal(fixture.requestCount(), 2);
                await fixture.assertClean();
            } finally {
                for (const lease of leases) await fixture.adapter.release(lease);
                await fixture.close();
            }
        });

        assert.equal(generationCalls, 0);
        assert.equal(disallowedFetches, 0);
        await assert.rejects(fs.access(unusedDefaultRoot), { code: "ENOENT" });
        suite.diagnostic(JSON.stringify({ generationCalls, disallowedFetches, unusedDefaultRootTouched: false }));
    });
} finally {
    globalThis.fetch = originalFetch;
    for (const key of environmentKeys) {
        const previous = previousEnvironment.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
    }
    assert.equal(path.dirname(tempRoot), path.resolve(os.tmpdir()));
    assert.ok(path.basename(tempRoot).startsWith("grok-availability-enforced-"));
    assert.equal((await fs.lstat(tempRoot)).isSymbolicLink(), false);
    await fs.rm(tempRoot, { recursive: true, force: true });
    console.log(JSON.stringify({ isolatedTempRoot: tempRoot, cleaned: true }));
}
