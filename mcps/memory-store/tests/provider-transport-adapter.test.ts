import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ProviderTransportAdapter } from "../src/provider-transport-adapter.ts";

async function main(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-transport-adapter-"));
    const adapter = new ProviderTransportAdapter({ mode: "test", dataRoot: root, ownerId: "provider-transport-adapter-test" });
    try {
        const events: Array<{ attemptId: string; settlement: string; recovered: boolean }> = [];
        const unsubscribe = adapter.subscribeAvailability(event => events.push(event));
        adapter.subscribeAvailability(async () => { throw new Error("listener failure must be isolated"); });

        const held = await Promise.all([
            adapter.acquire("grok", { attemptId: "transport-held-1" }),
            adapter.acquire("grok", { attemptId: "transport-held-2" }),
        ]);
        const beforeBlocked = adapter.diagnostics();
        const blocked = await adapter.tryAcquire("grok", { attemptId: "transport-blocked" });
        assert.equal(blocked, null);
        assert.deepEqual(adapter.diagnostics(), beforeBlocked);
        const blockedSnapshot = await adapter.admissionSnapshot("grok");
        assert.equal(blockedSnapshot.active, 2);
        assert.equal(blockedSnapshot.queuedForeground, 0);
        assert.equal(blockedSnapshot.queuedRecord, 0);

        assert.equal(await adapter.release(held[0]), true);
        assert.deepEqual({
            attemptId: "transport-held-1",
            settlement: events[0]?.settlement,
            recovered: events[0]?.recovered,
        }, {
            attemptId: "transport-held-1",
            settlement: "cancelled",
            recovered: false,
        });

        const granted = await adapter.tryAcquire("grok", { attemptId: "transport-after-release" });
        assert.notEqual(granted, null);
        assert.equal(adapter.diagnostics().acquireCount, 3);
        assert.equal(await adapter.release(granted!), true);

        const unknownLease = await adapter.tryAcquire("grok", { attemptId: "transport-unknown" });
        assert.notEqual(unknownLease, null);
        const eventsBeforeUnknown = events.length;
        await adapter.executeGranted(unknownLease!, async () => "unknown-result", () => "unknown");
        assert.equal(events.length, eventsBeforeUnknown, "unknown-outcome 仍占 uncertain 槽，不能发布 availability");
        assert.equal((await adapter.admissionSnapshot("grok")).uncertain, 1);

        const eventsBeforeAlreadySettled = events.length;
        const recovered = await adapter.settleRecoveredLease({
            provider: "grok",
            trafficClass: "foreground",
            attemptId: "transport-recovered",
            leaseId: "transport-recovered-lease",
            ownerEpoch: 1,
            capacityGeneration: 1,
            acquiredAt: 1,
            expiresAt: 2,
        });
        assert.equal(recovered.kind, "already-settled");
        assert.equal(events.length, eventsBeforeAlreadySettled, "already-settled 没有释放槽位，不能重复发布 availability");

        unsubscribe();
        const eventCountBeforeUnsubscribeRelease = events.length;
        assert.equal(await adapter.release(held[1]), true);
        assert.equal(events.length, eventCountBeforeUnsubscribeRelease);
    } finally {
        await adapter.close();
        await fs.rm(root, { recursive: true, force: true });
    }
    console.log("provider-transport-adapter tests passed");
}

await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
