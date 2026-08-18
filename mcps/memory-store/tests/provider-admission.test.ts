import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
    ProviderAdmissionCancelledError,
    ProviderAdmissionFencedError,
    createProviderAdmission,
    type ProviderAdmission,
    type ProviderAdmissionPermit,
    type ProviderTrafficClass,
} from "../src/provider-admission.ts";
import {
    mutateProviderControlAsOwner,
    readProviderControlStore,
    resolveProviderControlPaths,
    setProviderControlPathSafetyTestHookForTest,
} from "../src/provider-control-store.ts";

class FakeClock {
    constructor(readonly value: { nowMs: number }) {}
    now = (): number => this.value.nowMs;
    advance(milliseconds: number): void { this.value.nowMs += milliseconds; }
}

class GrantQueue<Value> {
    private readonly values: Value[] = [];
    private readonly waiters: Array<(value: Value) => void> = [];

    push(value: Value): void {
        const waiter = this.waiters.shift();
        if (waiter) waiter(value);
        else this.values.push(value);
    }

    async next(): Promise<Value> {
        const value = this.values.shift();
        if (value !== undefined) return value;
        return await new Promise(resolve => this.waiters.push(resolve));
    }
}

function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
    let resolve!: (value: Value) => void;
    const promise = new Promise<Value>(complete => { resolve = complete; });
    return { promise, resolve };
}

let sequence = 1;

function attempt(prefix: string): string {
    return `${prefix}-${sequence++}`;
}

async function createFixture(label: string, nowMs = 1_000, ownerLeaseDurationMs?: number): Promise<{ root: string; clock: FakeClock; admission: ProviderAdmission }> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `provider-admission-${label}-`));
    const clock = new FakeClock({ nowMs });
    const admission = createProviderAdmission({
        mode: "test",
        dataRoot: root,
        ownerId: `${label}-owner`,
        now: clock.now,
        ownerLeaseDurationMs,
        leaseDurationMs: ownerLeaseDurationMs ?? 60_000,
    });
    return { root, clock, admission };
}

async function acquire(admission: ProviderAdmission, provider: "grok" | "agy", trafficClass: ProviderTrafficClass, label: string, signal?: AbortSignal): Promise<ProviderAdmissionPermit> {
    return await admission.acquire(provider, trafficClass, { attemptId: attempt(label), signal });
}

async function tryAcquire(admission: ProviderAdmission, provider: "grok" | "agy", trafficClass: ProviderTrafficClass, label: string, signal?: AbortSignal): Promise<ProviderAdmissionPermit | null> {
    return await admission.tryAcquire(provider, trafficClass, { attemptId: attempt(label), signal });
}

async function warmToPhysicalMaximum(admission: ProviderAdmission, provider: "grok" | "agy", trafficClass: ProviderTrafficClass): Promise<void> {
    while ((await admission.snapshot(provider)).currentLimit! < 8) {
        const limit = (await admission.snapshot(provider)).currentLimit!;
        for (let index = 0; index < limit; index += 1) {
            const permit = await acquire(admission, provider, trafficClass, `warm-${provider}`);
            assert.equal(await permit.complete({ kind: "success" }), true);
        }
    }
}

async function openAgyMemoryLimit(dataRoot: string, clock: FakeClock, admission: ProviderAdmission): Promise<void> {
    const state = await admission.readControlState();
    if (!state?.ownerLease) throw new Error("agy memory test setup requires owner lease");
    await mutateProviderControlAsOwner({
        dataRoot,
        ownerEpoch: state.ownerEpoch,
        ownerLeaseId: state.ownerLease.leaseId,
        nowMs: clock.value.nowMs,
        mutate(control) {
            control.agy.memory.memoryAimdLimit = 8;
        },
    });
}

async function settleMicrotasks(): Promise<void> {
    await new Promise<void>(resolve => setImmediate(resolve));
}

async function testDefaultModes(): Promise<void> {
    const legacy = createProviderAdmission();
    const legacyPermit = await acquire(legacy, "grok", "foreground", "legacy");
    assert.equal(legacyPermit.receipt, null);
    assert.equal(await legacyPermit.release(), true);

    const shadow = createProviderAdmission({ mode: "shadow" });
    const shadowPermit = await acquire(shadow, "grok", "foreground", "shadow");
    assert.equal(shadowPermit.receipt, null);
    assert.equal((await shadow.snapshot("grok")).shadowGrants, 1);
    assert.equal(await shadowPermit.release(), true);
}

async function testTwoToOneFairness(): Promise<void> {
    const { root, admission } = await createFixture("fairness");
    try {
        const held = [
            await acquire(admission, "grok", "foreground", "held"),
            await acquire(admission, "grok", "foreground", "held"),
        ];
        const foreground = [
            acquire(admission, "grok", "foreground", "foreground"),
            acquire(admission, "grok", "foreground", "foreground"),
        ];
        const record = acquire(admission, "grok", "record", "record");

        assert.equal(await held[0].release(), true);
        const first = await foreground[0];
        assert.equal(await held[1].release(), true);
        const second = await foreground[1];
        assert.equal(await first.release(), true);
        const third = await record;

        assert.equal(first.trafficClass, "foreground");
        assert.equal(second.trafficClass, "foreground");
        assert.equal(third.trafficClass, "record");
        await Promise.all([second.release(), third.release()]);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testNoRecordStarvation(): Promise<void> {
    const { root, admission } = await createFixture("no-starvation");
    try {
        const held = [
            await acquire(admission, "grok", "foreground", "held"),
            await acquire(admission, "grok", "foreground", "held"),
        ];
        const grants = new GrantQueue<{ trafficClass: ProviderTrafficClass; permit: ProviderAdmissionPermit }>();
        for (let index = 0; index < 100; index += 1) {
            void acquire(admission, "grok", "foreground", "foreground-many").then(permit => grants.push({ trafficClass: "foreground", permit }));
        }
        for (let index = 0; index < 10; index += 1) {
            void acquire(admission, "grok", "record", "record-many").then(permit => grants.push({ trafficClass: "record", permit }));
        }

        let previous: ProviderAdmissionPermit | null = null;
        let recordGrants = 0;
        let firstRecordAt = -1;
        for (let index = 0; index < 110; index += 1) {
            if (index < held.length) assert.equal(await held[index].release(), true);
            else assert.equal(await previous!.release(), true);
            const granted = await grants.next();
            previous = granted.permit;
            if (granted.trafficClass === "record") {
                recordGrants += 1;
                if (firstRecordAt < 0) firstRecordAt = index;
            }
        }
        assert.equal(await previous!.release(), true);
        assert.equal(recordGrants, 10);
        assert.ok(firstRecordAt <= 2, `record should receive the third released slot, got index=${firstRecordAt}`);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testAgyBorrowAndReturn(): Promise<void> {
    const { root, clock, admission } = await createFixture("agy-borrow");
    try {
        await warmToPhysicalMaximum(admission, "agy", "agy-first-run-overflow");
        await openAgyMemoryLimit(root, clock, admission);
        const firstRun = await Promise.all(Array.from({ length: 8 }, () => acquire(admission, "agy", "agy-first-run-overflow", "agy-first")));
        const fallback = acquire(admission, "agy", "agy-fallback", "agy-fallback");
        const waitingFirstRun = acquire(admission, "agy", "agy-first-run-overflow", "agy-first-waiting");
        assert.equal(await firstRun[0].release(), true);
        const returned = await fallback;
        assert.equal(returned.trafficClass, "agy-fallback");
        await Promise.all([...firstRun.slice(1).map(permit => permit.release()), returned.release()]);
        const nextFirstRun = await waitingFirstRun;
        assert.equal(nextFirstRun.trafficClass, "agy-first-run-overflow");
        assert.equal(await nextFirstRun.release(), true);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }

    const balanced = await createFixture("agy-balanced");
    try {
        await warmToPhysicalMaximum(balanced.admission, "agy", "agy-first-run-overflow");
        await openAgyMemoryLimit(balanced.root, balanced.clock, balanced.admission);
        const first = Array.from({ length: 4 }, () => acquire(balanced.admission, "agy", "agy-first-run-overflow", "balanced-first"));
        const fallback = Array.from({ length: 4 }, () => acquire(balanced.admission, "agy", "agy-fallback", "balanced-fallback"));
        const permits = await Promise.all([...first, ...fallback]);
        const state = await balanced.admission.readControlState();
        assert.equal(state!.pools.agy.activeLeases.length, 8);
        assert.equal(state!.agy.admission.firstRunOverflowLeaseIds.length, 4);
        assert.equal(state!.agy.admission.fallbackLeaseIds.length, 4);
        await Promise.all(permits.map(permit => permit.release()));
    } finally {
        await balanced.admission.close();
        await fs.rm(balanced.root, { recursive: true, force: true });
    }
}

async function testSingleGenerationLoss(): Promise<void> {
    const { root, admission } = await createFixture("loss");
    try {
        await warmToPhysicalMaximum(admission, "grok", "foreground");
        const permits = await Promise.all(Array.from({ length: 8 }, () => acquire(admission, "grok", "foreground", "loss")));
        await Promise.all(permits.map(permit => permit.complete({ kind: "congestion" })));
        const snapshot = await admission.snapshot("grok");
        assert.equal(snapshot.currentLimit, 4);
        assert.equal(snapshot.lossEpoch, 1);
        assert.equal(snapshot.active, 0);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testRetryAfterAndSingleProbe(): Promise<void> {
    const { root, clock, admission } = await createFixture("probe");
    try {
        const failing = await acquire(admission, "grok", "foreground", "retry-after");
        assert.equal(await failing.complete({ kind: "congestion", retryAfterMs: 1_000 }), true);
        assert.equal((await admission.snapshot("grok")).breakerOpenUntilMs, clock.value.nowMs + 1_000);

        const first = acquire(admission, "grok", "foreground", "probe-first");
        const second = acquire(admission, "grok", "foreground", "probe-second");
        clock.advance(999);
        await admission.wake("grok");
        let firstSettled = false;
        void first.then(() => { firstSettled = true; });
        await settleMicrotasks();
        assert.equal(firstSettled, false);

        clock.advance(1);
        await admission.wake("grok");
        const probe = await first;
        assert.equal(probe.probe, true);
        let secondSettled = false;
        void second.then(() => { secondSettled = true; });
        await settleMicrotasks();
        assert.equal(secondSettled, false);
        assert.equal(await probe.complete({ kind: "success" }), true);
        const followup = await second;
        assert.equal(followup.probe, false);
        assert.equal(await followup.release(), true);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testTimeFrozenManualRecovery(): Promise<void> {
    const { root, clock, admission } = await createFixture("time-frozen");
    try {
        const initial = await acquire(admission, "grok", "foreground", "initial");
        assert.equal(await initial.release(), true);
        clock.value.nowMs -= 1;
        const waiting = acquire(admission, "grok", "foreground", "backward-clock");
        await admission.wake("grok");
        assert.equal((await admission.snapshot("grok")).frozen, true);
        clock.advance(2);
        const recovery = await admission.clearTimeFrozen("grok", "operator verified monotonic clock recovery from test evidence");
        assert.equal(recovery.evidence.includes("operator verified"), true);
        const permit = await waiting;
        assert.equal(await permit.release(), true);
        await admission.wake("grok");
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testUnknownGraceAndOwnerFence(): Promise<void> {
    const fixture = await createFixture("unknown");
    let replacement: ProviderAdmission | null = null;
    try {
        const unknown = await acquire(fixture.admission, "grok", "foreground", "unknown");
        assert.equal(await unknown.markUnknownOutcome(), true);
        assert.equal((await fixture.admission.snapshot("grok")).uncertain, 1);
        fixture.clock.advance(30_001);
        await fixture.admission.wake("grok");
        assert.equal((await fixture.admission.snapshot("grok")).uncertain, 1);

        replacement = createProviderAdmission({
            mode: "test",
            dataRoot: fixture.root,
            ownerId: "replacement-owner",
            now: fixture.clock.now,
            leaseDurationMs: 60_000,
        });
        const replacementPermit = await acquire(replacement, "grok", "foreground", "replacement");
        assert.equal((await replacement.snapshot("grok")).uncertain, 0);
        assert.equal(await unknown.complete({ kind: "success" }), true);
        await assert.rejects(() => unknown.assertCurrent(), ProviderAdmissionFencedError);
        assert.equal(await replacementPermit.release(), true);
    } finally {
        await replacement?.close();
        await fixture.admission.close();
        await fs.rm(fixture.root, { recursive: true, force: true });
    }
}

async function testOwnerLeaseRenewalAcrossTerms(): Promise<void> {
    const fixture = await createFixture("owner-renew", 1_000, 1_000);
    try {
        let ownerLeaseId: string | undefined;
        for (let round = 0; round < 5; round += 1) {
            const permit = await acquire(fixture.admission, "grok", "foreground", `owner-renew-${round}`);
            const afterAcquire = await fixture.admission.readControlState();
            assert.ok(afterAcquire?.ownerLease);
            ownerLeaseId ??= afterAcquire.ownerLease.leaseId;
            assert.equal(afterAcquire.ownerEpoch, 1);
            assert.equal(afterAcquire.ownerLease.leaseId, ownerLeaseId);
            fixture.clock.advance(700);
            assert.equal(await permit.complete({ kind: "success" }), true);
            const afterSettle = await fixture.admission.readControlState();
            assert.ok(afterSettle?.ownerLease);
            assert.equal(afterSettle.ownerEpoch, 1);
            assert.equal(afterSettle.ownerLease.leaseId, ownerLeaseId);
            assert.equal(afterSettle.ownerLease.expiresAtMs, fixture.clock.value.nowMs + 1_000);
        }
        assert.equal(fixture.clock.value.nowMs, 4_500);
        fixture.clock.advance(400);
        const horizonPermit = await acquire(fixture.admission, "grok", "foreground", "owner-renew-horizon");
        const horizonState = await fixture.admission.readControlState();
        assert.equal(horizonState?.ownerEpoch, 1);
        assert.equal(horizonState?.ownerLease?.leaseId, ownerLeaseId);
        assert.equal(horizonState?.ownerLease?.expiresAtMs, fixture.clock.value.nowMs + 1_000);
        assert.equal(await horizonPermit.release(), true);
    } finally {
        await fixture.admission.close();
        await fs.rm(fixture.root, { recursive: true, force: true });
    }
}

async function testExpiredOwnerReclaimsFreshLeaseAndFencesOldPermit(): Promise<void> {
    const fixture = await createFixture("owner-expired", 10_000, 1_000);
    try {
        const activePermit = await acquire(fixture.admission, "grok", "foreground", "owner-expired-active");
        const initialState = await fixture.admission.readControlState();
        assert.equal(initialState?.ownerEpoch, 1);
        fixture.clock.advance(1_001);
        const freshPermit = await acquire(fixture.admission, "grok", "foreground", "owner-expired-new");
        const afterReclaim = await fixture.admission.readControlState();
        assert.equal(afterReclaim?.ownerEpoch, 2, "an expired local owner must claim a fresh epoch instead of renewing stale credentials");
        assert.equal(afterReclaim?.pools.grok.activeLeases.length, 1, "the expired provider permit must be reclaimed before granting the new permit");
        assert.equal(await activePermit.complete({ kind: "success" }), false);
        assert.equal(await freshPermit.release(), true);
    } finally {
        await fixture.admission.close();
        await fs.rm(fixture.root, { recursive: true, force: true });
    }
}

async function testExpiredBreakerAllowsOwnerTakeoverProbe(): Promise<void> {
    const fixture = await createFixture("expired-breaker-takeover", 1_000, 1_000);
    let replacement: ProviderAdmission | null = null;
    try {
        const failing = await acquire(fixture.admission, "agy", "agy-first-run-overflow", "expired-breaker");
        assert.equal(await failing.complete({ kind: "availability", retryAfterMs: 500 }), true);
        assert.equal((await fixture.admission.snapshot("agy")).breakerOpenUntilMs, 1_500);
        await fixture.admission.close();

        fixture.clock.advance(1_500);
        replacement = createProviderAdmission({
            mode: "test",
            dataRoot: fixture.root,
            ownerId: "expired-breaker-replacement",
            now: fixture.clock.now,
            ownerLeaseDurationMs: 1_000,
            leaseDurationMs: 1_000,
        });
        const probe = await acquire(replacement, "agy", "agy-first-run-overflow", "expired-breaker-probe");
        assert.equal(probe.probe, true, "an expired breaker must survive owner takeover as one half-open probe instead of invalidating the store");
        const replacementState = await replacement.readControlState();
        assert.equal(replacementState?.pools.agy.breaker.openUntilMs, fixture.clock.value.nowMs);
        assert.equal(await probe.complete({ kind: "success" }), true);
        assert.equal((await replacement.snapshot("agy")).breakerOpenUntilMs, null);
    } finally {
        await replacement?.close();
        await fixture.admission.close();
        await fs.rm(fixture.root, { recursive: true, force: true });
    }
}

async function testCancellationDoesNotLeak(): Promise<void> {
    const { root, admission } = await createFixture("cancel");
    try {
        const held = [
            await acquire(admission, "grok", "foreground", "held"),
            await acquire(admission, "grok", "foreground", "held"),
        ];
        const controller = new AbortController();
        const cancelled = acquire(admission, "grok", "foreground", "cancelled", controller.signal);
        controller.abort();
        await assert.rejects(cancelled, ProviderAdmissionCancelledError);
        await Promise.all(held.map(permit => permit.release()));
        const permit = await acquire(admission, "grok", "foreground", "after-cancel");
        assert.equal((await admission.snapshot("grok")).active, 1);
        assert.equal(await permit.release(), true);
        assert.equal((await admission.snapshot("grok")).active, 0);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testCancellationWaitsForDurableGrantCleanup(): Promise<void> {
    const { root, admission } = await createFixture("cancel-grant-barrier");
    const grantPublished = deferred<{ attemptId: string; leaseId: string }>();
    const releaseGrant = deferred<void>();
    const cancelledAttemptId = attempt("cancelled-after-grant-publish");
    let barrierArmed = true;
    let publishedControlPath = "";
    let firstRelease: Promise<boolean> | null = null;
    let secondRelease: Promise<boolean> | null = null;
    let cancelled: Promise<ProviderAdmissionPermit> | null = null;
    setProviderControlPathSafetyTestHookForTest(async context => {
        if (!barrierArmed || context.phase !== "after-publish" || path.resolve(context.paths.dataRoot) !== path.resolve(root)) return;
        const control = JSON.parse(await fs.readFile(context.paths.controlPath, "utf8")) as {
            pools?: { grok?: { activeLeases?: Array<{ attemptId?: string; leaseId?: string }> } };
        };
        const lease = control.pools?.grok?.activeLeases?.find(item => item.attemptId === cancelledAttemptId);
        if (!lease?.attemptId || !lease.leaseId) return;
        barrierArmed = false;
        publishedControlPath = context.paths.controlPath;
        grantPublished.resolve({ attemptId: lease.attemptId, leaseId: lease.leaseId });
        await releaseGrant.promise;
    });
    try {
        const held = [
            await acquire(admission, "grok", "foreground", "barrier-held"),
            await acquire(admission, "grok", "foreground", "barrier-held"),
        ];
        const controller = new AbortController();
        cancelled = admission.acquire("grok", "foreground", { attemptId: cancelledAttemptId, signal: controller.signal });
        assert.equal((await admission.snapshot("grok")).queuedForeground, 1);

        let cancellationSettled = false;
        const observedCancellation = cancelled.then(
            () => { cancellationSettled = true; },
            () => { cancellationSettled = true; },
        );
        firstRelease = held[0].release();
        const persistedLease = await grantPublished.promise;
        assert.equal(persistedLease.attemptId, cancelledAttemptId);
        assert.ok(persistedLease.leaseId);

        controller.abort();
        await settleMicrotasks();
        assert.equal(cancellationSettled, false, "cancel must wait for a durably published in-flight grant to be reclaimed");
        const publishedState = JSON.parse(await fs.readFile(publishedControlPath, "utf8")) as {
            pools: { grok: { activeLeases: Array<{ attemptId: string; leaseId: string }> } };
        };
        assert.deepEqual(
            publishedState.pools.grok.activeLeases
                .filter(lease => lease.attemptId === cancelledAttemptId)
                .map(lease => ({ attemptId: lease.attemptId, leaseId: lease.leaseId })),
            [persistedLease],
        );

        secondRelease = held[1].release();
        releaseGrant.resolve(undefined);
        await assert.rejects(cancelled, ProviderAdmissionCancelledError);
        await observedCancellation;
        assert.equal(await firstRelease, true);
        assert.equal(await secondRelease, true);
        await admission.quiesce();
        const snapshot = await admission.snapshot("grok");
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.active, 0);
        assert.equal(snapshot.uncertain, 0);
        const settledState = await admission.readControlState();
        assert.equal(settledState?.pools.grok.activeLeases.some(lease => lease.attemptId === cancelledAttemptId), false);
    } finally {
        releaseGrant.resolve(undefined);
        setProviderControlPathSafetyTestHookForTest(undefined);
        await Promise.allSettled([
            ...(firstRelease ? [firstRelease] : []),
            ...(secondRelease ? [secondRelease] : []),
            ...(cancelled ? [cancelled] : []),
        ]);
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testRepeatedCancellationQuiesces(): Promise<void> {
    const { root, admission } = await createFixture("cancel-stress");
    try {
        for (let round = 0; round < 12; round += 1) {
            const held = [
                await acquire(admission, "grok", "foreground", `stress-held-${round}`),
                await acquire(admission, "grok", "foreground", `stress-held-${round}`),
            ];
            const controller = new AbortController();
            const cancelled = acquire(admission, "grok", "foreground", `stress-cancelled-${round}`, controller.signal);
            assert.equal((await admission.snapshot("grok")).queuedForeground, 1);
            controller.abort();
            await assert.rejects(cancelled, ProviderAdmissionCancelledError);
            assert.deepEqual(await Promise.all(held.map(permit => permit.release())), [true, true]);
            await admission.quiesce();
            const snapshot = await admission.snapshot("grok");
            assert.equal(snapshot.queuedForeground, 0);
            assert.equal(snapshot.queuedRecord, 0);
            assert.equal(snapshot.active, 0);
            assert.equal(snapshot.uncertain, 0);
        }
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testTryAcquireDoesNotQueueOrOverGrant(): Promise<void> {
    const { root, admission } = await createFixture("try-acquire-capacity");
    try {
        await warmToPhysicalMaximum(admission, "grok", "foreground");
        const held = await Promise.all(Array.from({ length: 8 }, () => acquire(admission, "grok", "foreground", "try-held")));
        const before = await admission.readControlState();
        const blocked = await tryAcquire(admission, "grok", "foreground", "try-blocked");
        assert.equal(blocked, null);
        const blockedSnapshot = await admission.snapshot("grok");
        const after = await admission.readControlState();
        assert.equal(blockedSnapshot.queuedForeground, 0);
        assert.equal(blockedSnapshot.queuedRecord, 0);
        assert.equal(blockedSnapshot.active, 8);
        assert.deepEqual(
            {
                activeLeases: after!.pools.grok.activeLeases,
                uncertainLeases: after!.pools.grok.uncertainLeases,
                successCredits: after!.pools.grok.successCredits,
                capacityGeneration: after!.pools.grok.capacityGeneration,
                breaker: after!.pools.grok.breaker,
                timeFrozen: after!.pools.grok.timeFrozen,
            },
            {
                activeLeases: before!.pools.grok.activeLeases,
                uncertainLeases: before!.pools.grok.uncertainLeases,
                successCredits: before!.pools.grok.successCredits,
                capacityGeneration: before!.pools.grok.capacityGeneration,
                breaker: before!.pools.grok.breaker,
                timeFrozen: before!.pools.grok.timeFrozen,
            },
        );

        assert.equal(await held[0].release(), true);
        const granted = await tryAcquire(admission, "grok", "foreground", "try-after-release");
        assert.notEqual(granted, null);
        assert.equal((await admission.snapshot("grok")).active, 8);
        assert.equal(await granted!.release(), true);
        await Promise.all(held.slice(1).map(permit => permit.release()));
        const drained = await admission.snapshot("grok");
        assert.equal(drained.active, 0);
        assert.equal(drained.queuedForeground, 0);
        assert.equal(drained.queuedRecord, 0);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }

    const concurrent = await createFixture("try-acquire-concurrent");
    try {
        await warmToPhysicalMaximum(concurrent.admission, "grok", "foreground");
        const permits = await Promise.all(Array.from(
            { length: 16 },
            () => tryAcquire(concurrent.admission, "grok", "foreground", "try-concurrent"),
        ));
        const granted = permits.filter((permit): permit is ProviderAdmissionPermit => permit !== null);
        assert.equal(granted.length, 8);
        assert.equal((await concurrent.admission.snapshot("grok")).active, 8);
        assert.equal((await concurrent.admission.snapshot("grok")).queuedForeground, 0);
        assert.equal((await concurrent.admission.snapshot("grok")).queuedRecord, 0);
        await Promise.all(granted.map(permit => permit.release()));
        assert.equal((await concurrent.admission.snapshot("grok")).active, 0);
    } finally {
        await concurrent.admission.close();
        await fs.rm(concurrent.root, { recursive: true, force: true });
    }
}

async function testTryAcquireRespectsAgyFourPlusFourBoundary(): Promise<void> {
    const { root, clock, admission } = await createFixture("try-acquire-agy");
    try {
        await warmToPhysicalMaximum(admission, "agy", "agy-first-run-overflow");
        await openAgyMemoryLimit(root, clock, admission);
        const first = await Promise.all(Array.from(
            { length: 4 },
            () => tryAcquire(admission, "agy", "agy-first-run-overflow", "try-agy-first"),
        ));
        const fallback = await Promise.all(Array.from(
            { length: 4 },
            () => tryAcquire(admission, "agy", "agy-fallback", "try-agy-fallback"),
        ));
        const permits = [...first, ...fallback];
        assert.equal(permits.every((permit): permit is ProviderAdmissionPermit => permit !== null), true);
        const before = await admission.readControlState();
        assert.equal(before!.agy.admission.firstRunOverflowLeaseIds.length, 4);
        assert.equal(before!.agy.admission.fallbackLeaseIds.length, 4);

        const blocked = await tryAcquire(admission, "agy", "agy-first-run-overflow", "try-agy-blocked");
        assert.equal(blocked, null);
        const after = await admission.readControlState();
        const snapshot = await admission.snapshot("agy");
        assert.equal(snapshot.active, 8);
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.queuedRecord, 0);
        assert.deepEqual(after!.agy.admission, before!.agy.admission);
        await Promise.all(permits.map(permit => permit!.release()));
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testTryAcquireReturnsNullForTemporaryBlocks(): Promise<void> {
    const breaker = await createFixture("try-acquire-breaker");
    try {
        const failing = await acquire(breaker.admission, "grok", "foreground", "try-breaker-failing");
        assert.equal(await failing.complete({ kind: "congestion", retryAfterMs: 1_000 }), true);
        assert.equal(await tryAcquire(breaker.admission, "grok", "foreground", "try-breaker-blocked"), null);
        const snapshot = await breaker.admission.snapshot("grok");
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.queuedRecord, 0);
        assert.equal(snapshot.active, 0);
    } finally {
        await breaker.admission.close();
        await fs.rm(breaker.root, { recursive: true, force: true });
    }

    const frozen = await createFixture("try-acquire-frozen");
    try {
        const initial = await acquire(frozen.admission, "grok", "foreground", "try-frozen-initial");
        assert.equal(await initial.release(), true);
        frozen.clock.value.nowMs -= 1;
        assert.equal(await tryAcquire(frozen.admission, "grok", "foreground", "try-frozen-blocked"), null);
        const snapshot = await frozen.admission.snapshot("grok");
        assert.equal(snapshot.frozen, true);
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.queuedRecord, 0);
    } finally {
        await frozen.admission.close();
        await fs.rm(frozen.root, { recursive: true, force: true });
    }

    const fenced = await createFixture("try-acquire-fenced");
    const takeover = createProviderAdmission({
        mode: "test",
        dataRoot: fenced.root,
        ownerId: "try-acquire-takeover",
        now: fenced.clock.now,
    });
    try {
        const initial = await acquire(fenced.admission, "grok", "foreground", "try-fence-initial");
        assert.equal(await initial.release(), true);
        const takeoverPermit = await acquire(takeover, "grok", "foreground", "try-fence-takeover");
        assert.equal(await takeoverPermit.release(), true);
        assert.equal(await tryAcquire(fenced.admission, "grok", "foreground", "try-fence-blocked"), null);
        const snapshot = await fenced.admission.snapshot("grok");
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.queuedRecord, 0);
        assert.equal(snapshot.active, 0);
    } finally {
        await takeover.close();
        await fenced.admission.close();
        await fs.rm(fenced.root, { recursive: true, force: true });
    }
}

async function testTryAcquireReconcilesPublishedGrantFailureWithoutCancellingExistingAttempt(): Promise<void> {
    const { root, admission } = await createFixture("try-acquire-publish-failure");
    const failedAttemptId = attempt("try-publish-failure");
    const existingAttemptId = attempt("try-existing-attempt");
    let injected = false;
    try {
        const initialized = await acquire(admission, "grok", "foreground", "try-publish-initialize");
        assert.equal(await initialized.release(), true);

        setProviderControlPathSafetyTestHookForTest(context => {
            if (context.phase !== "after-publish" || injected) return;
            injected = true;
            throw new Error("injected after-publish grant failure");
        });
        await assert.rejects(
            admission.tryAcquire("grok", "foreground", { attemptId: failedAttemptId }),
            /injected after-publish grant failure/u,
        );
        setProviderControlPathSafetyTestHookForTest(undefined);

        const reconciled = await admission.readControlState();
        assert.equal(injected, true);
        assert.equal(reconciled!.pools.grok.activeLeases.some(lease => lease.attemptId === failedAttemptId), false);
        assert.equal(reconciled!.pools.grok.uncertainLeases.some(lease => lease.attemptId === failedAttemptId), false);

        const retry = await admission.tryAcquire("grok", "foreground", { attemptId: failedAttemptId });
        assert.notEqual(retry, null, "same attempt must be grantable after the unknown publish result is reconciled");
        assert.equal(await retry!.release(), true);

        const existing = await admission.tryAcquire("grok", "foreground", { attemptId: existingAttemptId });
        assert.notEqual(existing, null);
        await assert.rejects(
            admission.tryAcquire("grok", "foreground", { attemptId: existingAttemptId }),
            (error: unknown) => error instanceof Error
                && (error as Error & { code?: string }).code === "ATTEMPT_ALREADY_LEASED",
        );
        const duplicateRejected = await admission.readControlState();
        assert.equal(
            duplicateRejected!.pools.grok.activeLeases.filter(lease => lease.attemptId === existingAttemptId).length,
            1,
            "duplicate attempt rejection must not cancel the legitimate live lease",
        );
        assert.equal(await existing!.release(), true);
    } finally {
        setProviderControlPathSafetyTestHookForTest(undefined);
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testTryAcquireYieldRepumpsOlderQueueAfterExpiryReclaim(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "provider-admission-try-yield-repump-"));
    const clock = new FakeClock({ nowMs: 1_000 });
    const admission = createProviderAdmission({
        mode: "test",
        dataRoot: root,
        ownerId: "try-yield-repump-owner",
        now: clock.now,
        ownerLeaseDurationMs: 60_000,
        leaseDurationMs: 10,
    });
    const olderAttemptId = attempt("try-yield-older");
    const candidateAttemptId = attempt("try-yield-candidate");
    try {
        const expiredA = await admission.acquire("grok", "foreground", { attemptId: attempt("try-yield-expired") });
        const expiredB = await admission.acquire("grok", "foreground", { attemptId: attempt("try-yield-expired") });
        const older = admission.acquire("grok", "foreground", { attemptId: olderAttemptId });
        await settleMicrotasks();
        assert.equal((await admission.snapshot("grok")).queuedForeground, 1);

        clock.advance(11);
        const candidate = await admission.tryAcquire("grok", "foreground", { attemptId: candidateAttemptId });
        assert.equal(candidate, null, "non-queueing candidate must yield to the older queued request");
        const olderPermit = await Promise.race([
            older,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error("older queued request was not repumped")), 2_000)),
        ]);
        assert.equal(olderPermit.attemptId, olderAttemptId);
        assert.equal(await olderPermit.release(), true);
        assert.equal(await expiredA.release(), false);
        assert.equal(await expiredB.release(), false);

        const state = await admission.readControlState();
        assert.equal(state!.pools.grok.activeLeases.some(lease => lease.attemptId === candidateAttemptId), false);
        assert.equal(state!.pools.grok.uncertainLeases.some(lease => lease.attemptId === candidateAttemptId), false);
        const snapshot = await admission.snapshot("grok");
        assert.equal(snapshot.queuedForeground, 0);
        assert.equal(snapshot.active, 0);
        assert.equal(snapshot.uncertain, 0);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testFreshTestModeRecoveryInitializesControlStore(): Promise<void> {
    const { root, clock, admission } = await createFixture("fresh-recovery");
    const sibling = createProviderAdmission({
        mode: "test",
        dataRoot: root,
        ownerId: "fresh-recovery-sibling-owner",
        now: clock.now,
        leaseDurationMs: 60_000,
    });
    try {
        const [recovered, siblingRecovered] = await Promise.all([
            admission.recoverAttempt("grok", "fresh-recovery-attempt"),
            sibling.recoverAttempt("grok", "fresh-recovery-sibling-attempt"),
        ]);
        assert.deepEqual(recovered, { kind: "absent" }, "test mode must initialize its fresh control store before a pre-acquire recovery probe");
        assert.deepEqual(siblingRecovered, { kind: "absent" }, "concurrent fresh recovery probes must share the exclusive first install without claiming ownership");
        const state = await admission.readControlState();
        assert.ok(state, "the recovery probe must leave a valid durable control state");
        assert.equal(state?.ownerLease, null, "a recovery-only first install must not claim the provider-control owner lease");
        assert.equal(state?.ownerEpoch, 0, "a recovery-only first install must not advance the provider-control owner epoch");
        const stored = await readProviderControlStore({ dataRoot: root });
        assert.equal(stored.kind, "current", "concurrent recovery-only first install must leave one readable provider-control store");
        assert.equal(stored.kind === "current" ? stored.receipt.controlRevision : -1, 1, "concurrent recovery-only first install must publish exactly one initial revision");
    } finally {
        await sibling.close();
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testRecoveryProbeDoesNotReconcileExpiredLease(): Promise<void> {
    const { root, clock, admission } = await createFixture("expired-recovery", 1_000, 10);
    const attemptId = "expired-recovery-attempt";
    try {
        const permit = await admission.acquire("grok", "record", { attemptId });
        clock.advance(11);
        const recovered = await admission.recoverAttempt("grok", attemptId);
        assert.equal(recovered.kind, "active", "recovery lookup must report the persisted lease without owner-side expiry reclamation");
        if (recovered.kind === "active") assert.deepEqual(recovered.identity, permit.leaseIdentity);
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function testRecoveryProbeReportsCorruptStore(): Promise<void> {
    const { root, admission } = await createFixture("corrupt-recovery");
    const paths = resolveProviderControlPaths({ dataRoot: root });
    try {
        assert.deepEqual(await admission.recoverAttempt("grok", "corrupt-recovery-bootstrap"), { kind: "absent" });
        const original = await fs.readFile(paths.controlPath);
        try {
            await fs.writeFile(paths.controlPath, "{broken", "utf8");
            const recovered = await admission.recoverAttempt("grok", "corrupt-recovery-attempt");
            assert.equal(recovered.kind, "corrupt", "recovery lookup must preserve the enforced-mode corrupt result instead of throwing through owner acquisition");
        } finally {
            await fs.writeFile(paths.controlPath, original);
        }
    } finally {
        await admission.close();
        await fs.rm(root, { recursive: true, force: true });
    }
}

async function main(): Promise<void> {
    await testDefaultModes();
    await testTwoToOneFairness();
    await testNoRecordStarvation();
    await testAgyBorrowAndReturn();
    await testSingleGenerationLoss();
    await testRetryAfterAndSingleProbe();
    await testTimeFrozenManualRecovery();
    await testUnknownGraceAndOwnerFence();
    await testOwnerLeaseRenewalAcrossTerms();
    await testExpiredOwnerReclaimsFreshLeaseAndFencesOldPermit();
    await testExpiredBreakerAllowsOwnerTakeoverProbe();
    await testCancellationDoesNotLeak();
    await testCancellationWaitsForDurableGrantCleanup();
    await testRepeatedCancellationQuiesces();
    await testTryAcquireDoesNotQueueOrOverGrant();
    await testTryAcquireRespectsAgyFourPlusFourBoundary();
    await testTryAcquireReturnsNullForTemporaryBlocks();
    await testTryAcquireReconcilesPublishedGrantFailureWithoutCancellingExistingAttempt();
    await testTryAcquireYieldRepumpsOlderQueueAfterExpiryReclaim();
    await testFreshTestModeRecoveryInitializesControlStore();
    await testRecoveryProbeDoesNotReconcileExpiredLease();
    await testRecoveryProbeReportsCorruptStore();
    console.log("provider-admission tests passed");
}

await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
