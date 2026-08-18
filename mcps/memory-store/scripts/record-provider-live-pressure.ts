import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { callAgyModel } from "../src/agy-client.ts";
import { createProviderAdmission, type ProviderAdmission } from "../src/provider-admission.ts";
import { mutateProviderControlAsOwner } from "../src/provider-control-store.ts";
import { configureProviderTransportAdapterForTest, resetProviderTransportAdapterForTest } from "../src/provider-transport-adapter.ts";
import type { ProviderId, ProviderTrafficClass } from "../src/provider-control-contracts.ts";

const AGY_MODEL = "Gemini 3.5 Flash (High)" as const;
const CALLS_PER_CLASS = 4;
const MAX_ACTIVE = 8;

async function warmToMaximum(admission: ProviderAdmission, provider: ProviderId, trafficClass: ProviderTrafficClass): Promise<void> {
    let sequence = 0;
    while ((await admission.snapshot(provider)).currentLimit! < MAX_ACTIVE) {
        const currentLimit = (await admission.snapshot(provider)).currentLimit!;
        for (let index = 0; index < currentLimit; index += 1) {
            const permit = await admission.acquire(provider, trafficClass, { attemptId: `live-warm-${provider}-${sequence++}` });
            assert.equal(await permit.complete({ kind: "success" }), true);
        }
    }
}

async function openAgyMemoryLimit(dataRoot: string, admission: ProviderAdmission): Promise<void> {
    const state = await admission.readControlState();
    if (!state?.ownerLease) throw new Error("provider control owner lease missing before agy pressure run");
    await mutateProviderControlAsOwner({
        dataRoot,
        ownerEpoch: state.ownerEpoch,
        ownerLeaseId: state.ownerLease.leaseId,
        nowMs: Date.now(),
        mutate(control) {
            control.agy.memory.memoryAimdLimit = MAX_ACTIVE;
        },
    });
}

async function runAgyCall(trafficClass: "agy-first-run-overflow" | "agy-fallback", ordinal: number) {
    const token = `${trafficClass}-${ordinal}`;
    const result = await callAgyModel(
        `Return exactly this token and nothing else: ${token}`,
        AGY_MODEL,
        {
            timeoutMs: 180_000,
            trafficClass,
            attemptId: `live-${token}`,
            cwd: process.cwd(),
        },
    );
    if (!result.text) throw new Error(`${token} failed: ${result.error || result.failureClass || "empty output"}`);
    return { trafficClass, ordinal, elapsedMs: result.elapsedMs, bytes: Buffer.byteLength(result.text, "utf8") };
}

async function main(): Promise<void> {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "record-provider-live-pressure-"));
    const admission = createProviderAdmission({
        mode: "test",
        dataRoot,
        ownerId: `record-provider-live-pressure-${process.pid}`,
        ownerLeaseDurationMs: 10 * 60_000,
        leaseDurationMs: 5 * 60_000,
    });
    let configured = false;
    const heldGrok = [];
    try {
        await warmToMaximum(admission, "grok", "foreground");
        await warmToMaximum(admission, "agy", "agy-first-run-overflow");
        await openAgyMemoryLimit(dataRoot, admission);
        for (let index = 0; index < MAX_ACTIVE; index += 1) {
            heldGrok.push(await admission.acquire("grok", "foreground", { attemptId: `live-grok-held-${index}` }));
        }
        await configureProviderTransportAdapterForTest({ mode: "test", admission });
        configured = true;

        let polling = true;
        let maxAgyActive = 0;
        let maxFirstRun = 0;
        let maxFallback = 0;
        const sampler = (async () => {
            while (polling) {
                const state = await admission.readControlState();
                if (state) {
                    maxAgyActive = Math.max(maxAgyActive, state.pools.agy.activeLeases.length);
                    maxFirstRun = Math.max(maxFirstRun, state.agy.admission.firstRunOverflowLeaseIds.length);
                    maxFallback = Math.max(maxFallback, state.agy.admission.fallbackLeaseIds.length);
                    assert.ok(state.pools.agy.activeLeases.length + state.pools.agy.uncertainLeases.length <= MAX_ACTIVE);
                    assert.equal(state.pools.grok.activeLeases.length, MAX_ACTIVE, "Grok saturation must remain isolated while agy executes");
                }
                await new Promise(resolve => setTimeout(resolve, 25));
            }
        })();

        const results = await Promise.all([
            ...Array.from({ length: CALLS_PER_CLASS }, (_, index) => runAgyCall("agy-first-run-overflow", index)),
            ...Array.from({ length: CALLS_PER_CLASS }, (_, index) => runAgyCall("agy-fallback", index)),
        ]);
        polling = false;
        await sampler;

        assert.equal(results.length, MAX_ACTIVE);
        assert.equal(maxAgyActive, MAX_ACTIVE);
        assert.ok(maxFirstRun >= CALLS_PER_CLASS, `first-run guarantee was not observed: ${maxFirstRun}`);
        assert.ok(maxFallback >= CALLS_PER_CLASS, `fallback guarantee was not observed: ${maxFallback}`);
        const settled = await admission.readControlState();
        assert.equal(settled?.pools.agy.activeLeases.length, 0);
        assert.equal(settled?.pools.agy.uncertainLeases.length, 0);
        assert.equal(settled?.agy.admission.firstRunOverflowLeaseIds.length, 0);
        assert.equal(settled?.agy.admission.fallbackLeaseIds.length, 0);
        console.log(JSON.stringify({
            kind: "record-provider-live-pressure",
            realAgyCalls: results.length,
            grokHeldPermits: heldGrok.length,
            maxAgyActive,
            maxFirstRun,
            maxFallback,
            results,
        }, null, 2));
    } finally {
        await Promise.allSettled(heldGrok.map(permit => permit.release()));
        if (configured) await resetProviderTransportAdapterForTest();
        else await admission.close();
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
}

await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
