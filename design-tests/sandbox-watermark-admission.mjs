import assert from "node:assert/strict";
import test from "node:test";
import { ResourceAdmissionController } from "../mcps/sandbox/src/resource-admission.ts";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const ample = { systemAvailableMemoryMB: 8192, commitAvailableMemoryMB: 32768, highMemorySignaled: true, lowMemorySignaled: false };

function scenario(options = {}, pressure = ample) {
    let time = 0;
    const admission = new ResourceAdmissionController({ requireFreshPressureSample: true, now: () => time, ...options });
    admission.updateSystemPressure(pressure);
    return { admission, tick: (milliseconds = 1000, nextPressure = pressure) => {
        time += milliseconds;
        admission.updateSystemPressure(nextPressure);
    } };
}

for (const incident of [
    { reserved: 1504, physical: 1731, commit: 9905, request: 64 },
    { reserved: 1504, physical: 2164, commit: 10164, request: 64 },
    { reserved: 1536, physical: 1737, commit: 9533, request: 24 },
    { reserved: 1536, physical: 2421, commit: 10471, request: 24 },
]) {
    test(`incident replay ${incident.reserved}/${incident.physical}/${incident.commit} admits ${incident.request}MB`, async () => {
        const pressure = { ...ample, systemAvailableMemoryMB: incident.physical, commitAvailableMemoryMB: incident.commit };
        const { admission, tick } = scenario({}, pressure);
        const existing = admission.adopt(incident.reserved);
        tick();
        const lease = await admission.acquire({ reservationMB: incident.request });
        assert.equal(lease.reservedMB, incident.request);
        assert.equal(admission.getState().wait.queuedTotal, 0);
        assert.equal(admission.getState().limits.admissionMode, "watermark");
        lease.release(); existing.release();
    });
}

test("ample memory admits sixty small callers beyond the old total reservation ceiling", async () => {
    const { admission } = scenario();
    const leases = await Promise.all(Array.from({ length: 60 }, (_, index) => admission.acquire({ ownerId: `owner-${index}`, reservationMB: 64 })));
    assert.equal(admission.getState().activeReservedMB, 3840);
    assert.equal(admission.getState().queued, 0);
    leases.forEach((lease) => lease.release());
    assert.equal(admission.getState().startupReservedMB, 0);
});

test("large total observations and a request exceeding old limits do not veto ample watermarks", async () => {
    const { admission } = scenario();
    admission.updateObservedMemoryMB(4096, 0);
    const lease = await admission.acquire({ reservationMB: 3072 });
    assert.equal(lease.reservedMB, 3072);
    assert.equal(admission.getState().hardLimitExceeded, false);
    lease.release();
});

test("explicit 24MB remains 24MB while an omitted request keeps the default estimate", async () => {
    const { admission } = scenario();
    const explicit = await admission.acquire({ reservationMB: 24 });
    const implicit = await admission.acquire();
    assert.equal(explicit.reservedMB, 24);
    assert.equal(implicit.reservedMB, 64);
    explicit.release(); implicit.release();
});

test("unstarted requests consume the same sample exactly once and never age out", async () => {
    const pressure = { ...ample, systemAvailableMemoryMB: 768 };
    const { admission, tick } = scenario({}, pressure);
    const leases = await Promise.all(Array.from({ length: 4 }, () => admission.acquire({ reservationMB: 64 })));
    assert.deepEqual(admission.inspectAdmission(24).blockedBy, ["physical_headroom"]);
    tick(10000);
    assert.equal(admission.getState().startupReservedMB, 256);
    assert.ok(admission.inspectAdmission(24).blockedBy.includes("physical_headroom"));
    leases.forEach((lease) => lease.release());
});

test("startup needs both a running signal and a later sample after the observation window", async () => {
    const { admission, tick } = scenario();
    const lease = await admission.acquire({ reservationMB: 512 });
    lease.markStarted();
    tick(999);
    assert.equal(admission.getState().startupReservedMB, 512);
    tick(1);
    assert.equal(admission.getState().startupReservedMB, 0);
    lease.release();
});

test("a downward estimate is corrected by the first actual process observation", async () => {
    const pressure = { ...ample, systemAvailableMemoryMB: 800 };
    const { admission, tick } = scenario({}, pressure);
    const lease = await admission.acquire({ reservationMB: 24 });
    lease.observeMemoryMB(256);
    assert.equal(admission.getState().startupReservedMB, 256);
    assert.ok(admission.inspectAdmission(64).blockedBy.includes("physical_headroom"));
    tick(1000, { ...pressure, systemAvailableMemoryMB: 544 });
    assert.deepEqual(admission.inspectAdmission(24).blockedBy, []);
    lease.release();
});

test("an oversized long-lived estimate retires rather than blocking all future small work", async () => {
    const { admission, tick } = scenario();
    const lease = await admission.acquire({ reservationMB: 4096 });
    lease.observeMemoryMB(20);
    tick(1000, { ...ample, systemAvailableMemoryMB: 900, highMemorySignaled: false });
    const small = await admission.acquire({ reservationMB: 24 });
    assert.equal(admission.getState().startupReservedMB, 24);
    assert.ok(admission.inspectAdmission(256).blockedBy.includes("heavy_request_yellow"));
    small.release(); lease.release();
});

test("observed growth after startup is charged until a later system sample covers it", async () => {
    const { admission, tick } = scenario();
    const lease = await admission.acquire({ reservationMB: 24 });
    lease.observeMemoryMB(32);
    tick();
    assert.equal(admission.getState().startupReservedMB, 0);
    lease.observeMemoryMB(200);
    assert.equal(admission.getState().startupReservedMB, 168);
    lease.observeMemoryMB(250);
    assert.equal(admission.getState().startupReservedMB, 218);
    tick(100);
    assert.equal(admission.getState().startupReservedMB, 0);
    lease.observeMemoryMB(250);
    assert.equal(admission.getState().startupReservedMB, 0);
    lease.release();
});

for (const [name, pressure, reason] of [
    ["physical emergency", { ...ample, systemAvailableMemoryMB: 511 }, "emergency_pressure"],
    ["commit emergency", { ...ample, commitAvailableMemoryMB: 1535 }, "emergency_pressure"],
    ["Windows low notification", { ...ample, lowMemorySignaled: true }, "windows_low_memory"],
    ["projected physical floor", { ...ample, systemAvailableMemoryMB: 530 }, "physical_headroom"],
    ["projected commit floor", { ...ample, commitAvailableMemoryMB: 1550 }, "commit_headroom"],
]) {
    test(`${name} still blocks new small work with an exact reason`, async () => {
        const { admission } = scenario({ admissionBudgetMinMs: 10, admissionBudgetMaxMs: 10 }, pressure);
        const pending = admission.acquire({ reservationMB: 24 }).catch((error) => error);
        await delay(20);
        const error = await pending;
        assert.equal(error.code, "admission_timeout");
        assert.ok(error.admissionDecision.blockedBy.includes(reason));
        assert.equal(error.admissionDecision.reservedMB, 24);
        assert.equal(admission.getState().activeLeases, 0);
    });
}

test("missing and stale pressure samples cannot be replaced by a physical-only fallback on Windows", () => {
    let time = 0;
    const admission = new ResourceAdmissionController({ now: () => time, requireFreshPressureSample: true });
    assert.ok(admission.inspectAdmission(24).blockedBy.includes("missing_pressure_sample"));
    admission.updateSystemPressure(ample);
    time = 2001;
    assert.ok(admission.inspectAdmission(24).blockedBy.includes("stale_pressure_sample"));
    admission.updateSystemAvailableMemoryMB(8192);
    assert.ok(admission.inspectAdmission(24).blockedBy.includes("missing_pressure_sample"));
});

test("equal-valued new samples retire startup estimates and wake the queue", async () => {
    const pressure = { ...ample, systemAvailableMemoryMB: 768 };
    const { admission, tick } = scenario({}, pressure);
    const holder = admission.adopt(256);
    holder.markStarted();
    const pending = admission.acquire({ reservationMB: 24 });
    assert.equal(admission.getState().queued, 1);
    tick();
    const lease = await pending;
    assert.equal(admission.getState().queued, 0);
    lease.release(); holder.release();
});

test("queued heavy work does not reserve imaginary capacity against safe small work", async () => {
    const pressure = { ...ample, systemAvailableMemoryMB: 900, highMemorySignaled: false };
    const { admission, tick } = scenario({}, pressure);
    const cancel = new AbortController();
    const heavy = admission.acquire({ ownerId: "heavy", reservationMB: 512, signal: cancel.signal }).catch((error) => error);
    tick(5000);
    for (let index = 0; index < 40; index += 1) {
        const small = await admission.acquire({ ownerId: `small-${index}`, reservationMB: 24 });
        small.release();
    }
    assert.equal(admission.getState().queued, 1);
    cancel.abort();
    assert.equal((await heavy).code, "admission_aborted");
    assert.equal(admission.getState().activeLeases, 0);
});

test("cancellation never grants later and released observations cannot mutate accounting", async () => {
    const { admission, tick } = scenario({}, { ...ample, lowMemorySignaled: true });
    const cancel = new AbortController();
    const pending = admission.acquire({ reservationMB: 24, signal: cancel.signal }).catch((error) => error);
    cancel.abort();
    tick(1000, ample);
    assert.equal((await pending).code, "admission_aborted");
    const lease = await admission.acquire({ reservationMB: 24 });
    assert.equal(lease.release(), true);
    assert.equal(lease.release(), false);
    lease.markStarted(); lease.observeMemoryMB(1024);
    assert.equal(admission.getState().startupReservedMB, 0);
    assert.equal(admission.getState().activeLeases, 0);
});

test("recovery gate preserves existing leases until a fresh running sample is available", async () => {
    const { admission, tick } = scenario();
    admission.setRecoveryPending(true);
    const existing = admission.adopt(5000);
    assert.ok(admission.inspectAdmission(24).blockedBy.includes("resource_recovery_pending"));
    tick();
    admission.setRecoveryPending(false);
    const lease = await admission.acquire({ reservationMB: 24 });
    assert.equal(admission.getState().activeReservedMB, 5024);
    assert.equal(admission.getState().startupReservedMB, 24);
    lease.release(); existing.release();
});
