import assert from "node:assert/strict";
import test from "node:test";
import { ResourceAdmissionController } from "../mcps/sandbox/src/resource-admission.ts";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const snapshot = {
    systemAvailableMemoryMB: 726,
    commitAvailableMemoryMB: 7252,
    highMemorySignaled: true,
    lowMemorySignaled: false,
};

function createScenario(options = {}, pressure = snapshot) {
    const admission = new ResourceAdmissionController({
        admissionBudgetMinMs: 150,
        admissionBudgetMaxMs: 150,
        ...options,
    });
    const holders = [admission.adopt(192), admission.adopt(192)];
    admission.updateSystemPressure(pressure);
    return { admission, holders };
}

test("reported 726/7252/384 snapshot admits a 64MB request even with zero observations", async () => {
    const { admission, holders } = createScenario();
    try {
        const lease = await admission.acquire({ ownerId: "incident-small", reservationMB: 64 });
        assert.equal(admission.getState().wait.queuedTotal, 0);
        lease.release();
    } finally {
        holders.forEach((lease) => lease.release());
    }
});

test("weight 1 retains old blocking behavior with an explicit physical-floor diagnosis", async () => {
    const { admission, holders } = createScenario({ smallRequestPhysicalWeight: 1 });
    try {
        await assert.rejects(admission.acquire({ reservationMB: 64 }), (error) => {
            assert.equal(error.code, "admission_timeout");
            assert.ok(error.admissionDecision.blockedBy.includes("physical_headroom"));
            assert.equal(error.admissionDecision.projectedPhysicalAvailableMB, 278);
            return true;
        });
    } finally {
        holders.forEach((lease) => lease.release());
    }
});

test("14:17 nearby 752/7758/512 snapshot with withdrawn high-memory signal permits a small command", async () => {
    const { admission, holders } = createScenario({}, {
        ...snapshot, systemAvailableMemoryMB: 752, commitAvailableMemoryMB: 7758, highMemorySignaled: false,
    });
    holders.push(admission.adopt(128));
    try {
        const lease = await admission.acquire({ ownerId: "nearby-sample", reservationMB: 64 });
        assert.equal(admission.getState().wait.queuedTotal, 0);
        lease.release();
    } finally {
        holders.forEach((lease) => lease.release());
    }
});

test("observations changing from zero to partial and complete do not deadlock queued work", async () => {
    const { admission, holders } = createScenario({ smallRequestPhysicalWeight: 1 });
    let started = false;
    const pending = admission.acquire({ reservationMB: 64 }).then((lease) => { started = true; return lease; });
    admission.updateObservedMemoryMB(100);
    await delay(5);
    assert.equal(started, false);
    admission.updateObservedMemoryMB(256);
    const lease = await pending;
    lease.release();
    holders.forEach((holder) => holder.release());
});

test("twenty queued short callers progress behind a blocked heavy caller without admitting it", async () => {
    const { admission, holders } = createScenario({ admissionBudgetMinMs: 800, admissionBudgetMaxMs: 800 });
    const abortHeavy = new AbortController();
    const heavy = admission.acquire({ ownerId: "heavy", reservationMB: 512, signal: abortHeavy.signal }).catch((error) => error);
    let completed = 0;
    try {
        const callers = Array.from({ length: 20 }, (_, index) => admission.acquire({
            ownerId: `short-${index}`,
            reservationMB: 64,
        }).then(async (lease) => {
            assert.ok(admission.getState().activeReservedMB <= 640);
            await delay(10);
            lease.release();
            completed += 1;
        }));
        await Promise.all(callers);
        assert.equal(completed, 20);
        assert.equal(admission.getState().queued, 1);
        assert.equal(admission.getState().wait.timedOutTotal, 0);
        assert.ok(admission.getState().peak.queued > 1);
    } finally {
        abortHeavy.abort();
        holders.forEach((lease) => lease.release());
    }
    assert.equal((await heavy).code, "admission_aborted");
});

for (const [name, pressure] of [
    ["low-memory notification", { ...snapshot, lowMemorySignaled: true }],
    ["physical emergency floor", { ...snapshot, systemAvailableMemoryMB: 511 }],
    ["commit emergency floor", { ...snapshot, commitAvailableMemoryMB: 1535 }],
    ["full commit reservations", { ...snapshot, commitAvailableMemoryMB: 1900 }],
    ["commit target not preserved", { ...snapshot, commitAvailableMemoryMB: 4500 }],
]) {
    test(`small requests do not bypass ${name}`, async () => {
        const { admission, holders } = createScenario({}, pressure);
        try {
            await assert.rejects(admission.acquire({ reservationMB: 64 }), { code: "admission_timeout" });
        } finally {
            holders.forEach((lease) => lease.release());
        }
    });
}

test("unknown or stale Windows pressure does not enable discounted reservations", async () => {
    let now = 1000;
    const { admission, holders } = createScenario({ now: () => now });
    now += 2501;
    try {
        await assert.rejects(admission.acquire({ reservationMB: 64 }), { code: "admission_timeout" });
        admission.updateSystemPressure(snapshot);
        const lease = await admission.acquire({ reservationMB: 64 });
        lease.release();
    } finally {
        holders.forEach((lease) => lease.release());
    }
    const unknown = new ResourceAdmissionController({ admissionBudgetMinMs: 50, admissionBudgetMaxMs: 50 });
    const holder = unknown.adopt(384);
    unknown.updateSystemAvailableMemoryMB(726);
    try {
        await assert.rejects(unknown.acquire({ reservationMB: 64 }), { code: "admission_timeout" });
    } finally {
        holder.release();
    }
});

test("falling pressure pauses pending work and refreshed safe pressure resumes it", async () => {
    const { admission, holders } = createScenario();
    const first = await admission.acquire({ reservationMB: 64 });
    admission.updateSystemPressure({ ...snapshot, lowMemorySignaled: true });
    let started = false;
    const pending = admission.acquire({ reservationMB: 64 }).then((lease) => { started = true; return lease; });
    await delay(10);
    assert.equal(started, false);
    admission.updateSystemPressure(snapshot);
    const next = await pending;
    next.release();
    first.release();
    holders.forEach((lease) => lease.release());
});

test("invalid physical weight is rejected rather than silently disabling the buffer", () => {
    for (const smallRequestPhysicalWeight of [0, -1, 1.01, NaN]) {
        assert.throws(() => new ResourceAdmissionController({ smallRequestPhysicalWeight }), /smallRequestPhysicalWeight/);
    }
});

test("Windows admission requires a complete fresh pressure sample even when free RAM looks ample", async () => {
    let now = 1000;
    const admission = new ResourceAdmissionController({
        requireFreshPressureSample: true, now: () => now,
        admissionBudgetMinMs: 30, admissionBudgetMaxMs: 30,
    });
    admission.updateSystemAvailableMemoryMB(8192);
    await assert.rejects(admission.acquire({ reservationMB: 64 }), (error) => {
        assert.ok(error.toJSON().admissionDecision.blockedBy.includes("missing_pressure_sample"));
        return true;
    });
    admission.updateSystemPressure({ ...snapshot, systemAvailableMemoryMB: 8192 });
    now += 2001;
    await assert.rejects(admission.acquire({ reservationMB: 64 }), (error) => {
        assert.ok(error.admissionDecision.blockedBy.includes("stale_pressure_sample"));
        return true;
    });
    const pending = admission.acquire({ reservationMB: 64 });
    admission.updateSystemPressure({ ...snapshot, systemAvailableMemoryMB: 8192 });
    (await pending).release();
    assert.equal(admission.getState().activeLeases, 0);
});

test("registry recovery blocks new work but not controls and resumes only after lease adoption", async () => {
    const admission = new ResourceAdmissionController({ admissionBudgetMinMs: 100, admissionBudgetMaxMs: 100 });
    admission.setRecoveryPending(true);
    assert.ok(admission.inspectAdmission(64).blockedBy.includes("resource_recovery_pending"));
    const control = await admission.acquire({ control: true });
    control.release();
    let started = false;
    const pending = admission.acquire({ reservationMB: 64 }).then((lease) => { started = true; return lease; });
    await delay(5);
    assert.equal(started, false);
    const restored = admission.adopt(1536);
    admission.setRecoveryPending(false);
    await delay(5);
    assert.equal(started, false);
    restored.release();
    (await pending).release();
    assert.equal(admission.getState().recoveryPending, false);
});

test("new and aged reservations are never physically discounted", () => {
    const { admission, holders } = createScenario();
    try {
        const small = admission.inspectAdmission(64, 128);
        assert.equal(small.projectedPhysicalAvailableMB, 438);
        assert.equal(small.projectedCommitAvailableMB, 6676);
        assert.ok(small.blockedBy.includes("physical_headroom"));
        for (const reservationMB of [128, 192]) {
            assert.ok(admission.inspectAdmission(reservationMB).blockedBy.includes("physical_headroom"));
        }
    } finally {
        holders.forEach((holder) => holder.release());
    }
});

test("raw observed memory cannot credit another lease and still enforces the hard limit", () => {
    const { admission, holders } = createScenario();
    try {
        admission.updateObservedMemoryMB(768, 64);
        assert.equal(admission.getState().observedMemoryMB, 768);
        assert.equal(admission.inspectAdmission(64).projectedPhysicalAvailableMB, 582);
        assert.equal(admission.inspectAdmission(64).projectedCommitAvailableMB, 6868);
        admission.updateObservedMemoryMB(2048, 64);
        assert.ok(admission.inspectAdmission(64).blockedBy.includes("observed_hard_limit"));
        assert.throws(() => admission.updateObservedMemoryMB(64, 65), /reservationCreditMB/);
    } finally {
        holders.forEach((holder) => holder.release());
    }
});
