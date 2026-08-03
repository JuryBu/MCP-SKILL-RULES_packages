import assert from "node:assert/strict";
import test from "node:test";
import {
    ResourceAdmissionController,
    ResourceAdmissionError,
} from "../mcps/sandbox/src/resource-admission.ts";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test("20 small commands start immediately without a process-count ceiling", async () => {
    const admission = new ResourceAdmissionController();
    const leases = await Promise.all(Array.from(
        { length: 20 },
        (_, index) => admission.acquire({ ownerId: `owner-${index}`, reservationMB: 64 }),
    ));

    const state = admission.getState();
    assert.deepEqual(state.limits, {
        minReservationMB: 64,
        admissionLimitMB: 1536,
        hardLimitMB: 2048,
        systemHeadroomMB: 1024,
        maxQueueSize: 256,
    });
    assert.equal(state.activeLeases, 20);
    assert.equal(state.activeReservedMB, 1280);
    assert.equal(state.queued, 0);
    assert.equal(state.peak.activeReservedMB, 1280);
    assert.equal(state.wait.queuedTotal, 0);

    for (const lease of leases) lease.release();
});

test("1024MB plus 512MB makes a later 64MB request wait", async () => {
    const admission = new ResourceAdmissionController();
    const large = await admission.acquire({ ownerId: "large", reservationMB: 1024 });
    const medium = await admission.acquire({ ownerId: "medium", reservationMB: 512 });
    let smallStarted = false;
    const smallPromise = admission.acquire({ ownerId: "small", reservationMB: 64 })
        .then((lease) => {
            smallStarted = true;
            return lease;
        });

    await delay(10);
    assert.equal(smallStarted, false);
    assert.equal(admission.getState().queued, 1);

    medium.release();
    const small = await smallPromise;
    assert.equal(smallStarted, true);
    assert.equal(admission.getState().activeReservedMB, 1088);

    small.release();
    large.release();
});

test("queued owners rotate instead of letting one owner drain first", async () => {
    const admission = new ResourceAdmissionController();
    const holder = await admission.acquire({ ownerId: "holder", reservationMB: 1536 });
    const grantOrder = [];

    const pending = [
        ["A-1", "owner-a"],
        ["A-2", "owner-a"],
        ["B-1", "owner-b"],
        ["B-2", "owner-b"],
    ].map(([label, ownerId]) => admission.acquire({ ownerId, reservationMB: 64 })
        .then((lease) => {
            grantOrder.push(label);
            return lease;
        }));

    holder.release();
    const leases = await Promise.all(pending);
    assert.deepEqual(grantOrder, ["A-1", "B-1", "A-2", "B-2"]);

    for (const lease of leases) lease.release();
});

test("an aged request reserves headroom instead of starving behind smaller work", async () => {
    const admission = new ResourceAdmissionController({
        admissionLimitMB: 256,
        hardLimitMB: 512,
        agingThresholdMs: 20,
    });
    const firstHolder = await admission.acquire({ ownerId: "holder-a", reservationMB: 192 });
    const secondHolder = await admission.acquire({ ownerId: "holder-b", reservationMB: 64 });
    const grantOrder = [];
    const aged = admission.acquire({ ownerId: "aged", reservationMB: 128 })
        .then((lease) => {
            grantOrder.push("aged");
            return lease;
        });
    const small = admission.acquire({ ownerId: "small", reservationMB: 64 })
        .then((lease) => {
            grantOrder.push("small");
            return lease;
        });

    await delay(30);
    secondHolder.release();
    await delay(10);
    assert.deepEqual(grantOrder, []);

    firstHolder.release();
    const leases = await Promise.all([aged, small]);
    assert.deepEqual(grantOrder, ["aged", "small"]);

    for (const lease of leases) lease.release();
});

test("aborting a queued request removes it and it never starts later", async () => {
    const admission = new ResourceAdmissionController();
    const holder = await admission.acquire({ ownerId: "holder", reservationMB: 1536 });
    const controller = new AbortController();
    let started = false;
    const pending = admission.acquire({
        ownerId: "cancelled",
        reservationMB: 64,
        signal: controller.signal,
    }).then((lease) => {
        started = true;
        return lease;
    });

    controller.abort();
    await assert.rejects(pending, (error) => {
        assert.ok(error instanceof ResourceAdmissionError);
        assert.equal(error.code, "admission_aborted");
        return true;
    });
    assert.equal(admission.getState().queued, 0);

    holder.release();
    await delay(10);
    assert.equal(started, false);
    assert.equal(admission.getState().activeReservedMB, 0);
});

test("admission timeout reports queue wait and randomized retry delay", async () => {
    const admission = new ResourceAdmissionController({ random: () => 0.5 });
    const holder = await admission.acquire({ ownerId: "holder", reservationMB: 1536 });
    const startedAt = Date.now();

    await assert.rejects(
        admission.acquire({
            ownerId: "timed-out",
            reservationMB: 64,
            admissionBudgetMs: 30,
        }),
        (error) => {
            assert.ok(error instanceof ResourceAdmissionError);
            assert.equal(error.code, "admission_timeout");
            assert.ok(error.queueWaitMs >= 20);
            assert.equal(error.retryAfterMs, 4000);
            assert.match(error.message, /before the command started/u);
            return true;
        },
    );

    assert.ok(Date.now() - startedAt >= 20);
    const state = admission.getState();
    assert.equal(state.queued, 0);
    assert.equal(state.wait.timedOutTotal, 1);
    assert.equal(state.wait.completedTotal, 1);
    holder.release();
});

test("lease release is idempotent", async () => {
    const admission = new ResourceAdmissionController();
    const lease = await admission.acquire({ ownerId: "owner", reservationMB: 64 });

    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    assert.equal(admission.getState().activeReservedMB, 0);
    assert.equal(admission.getState().activeLeases, 0);
});

test("control work bypasses admission without entering resource state", async () => {
    const admission = new ResourceAdmissionController();
    const holder = await admission.acquire({ ownerId: "holder", reservationMB: 1536 });
    const control = await admission.acquireControl();

    const state = admission.getState();
    assert.equal(control.control, true);
    assert.equal(control.reservedMB, 0);
    assert.equal(state.activeReservedMB, 1536);
    assert.equal(state.queued, 0);
    assert.equal(control.release(), true);
    assert.equal(control.release(), false);
    holder.release();
});

test("hard-line telemetry blocks new admissions until memory recovers", async () => {
    const admission = new ResourceAdmissionController();
    admission.updateObservedMemoryMB(2048);
    let started = false;
    const pending = admission.acquire({
        ownerId: "blocked-by-hard-line",
        reservationMB: 64,
        admissionBudgetMs: 200,
    }).then((lease) => {
        started = true;
        return lease;
    });

    await delay(10);
    assert.equal(started, false);
    assert.equal(admission.getState().hardLimitExceeded, true);
    admission.updateObservedMemoryMB(1024);

    const lease = await pending;
    assert.equal(started, true);
    assert.equal(admission.getState().peak.observedMemoryMB, 2048);
    lease.release();
});

test("system headroom blocks heavy work without starving a small command", async () => {
    const admission = new ResourceAdmissionController({ systemHeadroomMB: 1024 });
    admission.updateSystemAvailableMemoryMB(1500);
    let heavyStarted = false;
    const heavy = admission.acquire({
        ownerId: "heavy",
        reservationMB: 512,
        admissionBudgetMs: 200,
    }).then((lease) => {
        heavyStarted = true;
        return lease;
    });

    await delay(10);
    assert.equal(heavyStarted, false);
    const small = await admission.acquire({ ownerId: "small", reservationMB: 64 });
    assert.equal(small.reservedMB, 64);
    assert.equal(admission.getState().systemAvailableMemoryMB, 1500);
    small.release();

    admission.updateSystemAvailableMemoryMB(2500);
    const heavyLease = await heavy;
    assert.equal(heavyStarted, true);
    heavyLease.release();
});

test("state reports aggregate pressure without retaining request payloads", async () => {
    const admission = new ResourceAdmissionController();
    const lease = await admission.acquire({
        ownerId: "private-owner",
        reservationMB: 64,
        command: "private-command",
    });
    const serialized = JSON.stringify(admission.getState());

    assert.doesNotMatch(serialized, /private-owner|private-command/u);
    assert.match(serialized, /activeReservedMB/u);
    assert.match(serialized, /queued/u);
    assert.match(serialized, /peak/u);
    assert.match(serialized, /averageMs/u);
    lease.release();
});
