import assert from "node:assert/strict";
import test from "node:test";
import { ResourceAdmissionController } from "../mcps/sandbox/src/resource-admission.ts";

const green = { systemAvailableMemoryMB: 4096, commitAvailableMemoryMB: 16384, highMemorySignaled: true, lowMemorySignaled: false };

test("seeded mixed owners, biased estimates, burst arrivals and pressure changes retain progress", async () => {
    const reports = [];
    for (const concurrency of [1, 5, 10, 20]) {
        let clock = 0;
        let seed = 1180 + concurrency;
        const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
        const admission = new ResourceAdmissionController({ now: () => clock, requireFreshPressureSample: true });
        const active = [];
        const held = admission.adopt(3000);
        let started = 0;
        let deferred = 0;
        let smallStarted = 0;
        let largeStarted = 0;
        let dangerousStarts = 0;
        let maxRemembered = 3000;
        const decisions = new Set();
        for (let step = 0; step < 100; step += 1) {
            clock += 200;
            for (let index = active.length - 1; index >= 0; index -= 1) {
                if (active[index].finishAt <= clock) { active[index].lease.release(); active.splice(index, 1); }
            }
            const actual = active.reduce((total, task) => total + task.actualMB, 0);
            const phase = step % 25;
            const pressure = {
                ...green,
                systemAvailableMemoryMB: Math.max(0, (phase < 3 ? 1200 : 4096) - actual),
                commitAvailableMemoryMB: Math.max(0, (phase === 10 ? 1800 : 16384) - actual),
                lowMemorySignaled: phase === 15,
                highMemorySignaled: phase >= 3,
            };
            admission.updateSystemPressure(pressure);
            for (let requestIndex = 0; requestIndex < concurrency; requestIndex += 1) {
                const small = random() < 0.8;
                const reservationMB = small ? [16, 24, 64][Math.floor(random() * 3)] : 512;
                const decision = admission.inspectAdmission(reservationMB);
                decision.blockedBy.forEach((reason) => decisions.add(reason));
                assert.ok(!decision.blockedBy.includes("reservation_capacity"));
                assert.ok(!decision.blockedBy.includes("observed_hard_limit"));
                if (decision.blockedBy.length) { deferred += 1; continue; }
                const lease = await admission.acquire({ ownerId: `owner-${requestIndex % 5}`, reservationMB });
                if (pressure.lowMemorySignaled || pressure.systemAvailableMemoryMB < 512 || pressure.commitAvailableMemoryMB < 1536) dangerousStarts += 1;
                const actualMB = small ? 18 + Math.floor(random() * 25) : 128 + Math.floor(random() * 640);
                lease.observeMemoryMB(actualMB);
                active.push({ lease, actualMB, finishAt: clock + (small ? 100 : 1000) });
                started += 1;
                if (small) smallStarted += 1; else largeStarted += 1;
                maxRemembered = Math.max(maxRemembered, admission.getState().activeReservedMB);
            }
        }
        active.forEach((task) => task.lease.release());
        held.release();
        assert.equal(dangerousStarts, 0);
        assert.ok(started > concurrency * 25);
        assert.ok(smallStarted > largeStarted);
        assert.ok(largeStarted > 0);
        assert.ok(deferred > 0);
        assert.equal(admission.getState().activeLeases, 0);
        assert.equal(admission.getState().startupReservedMB, 0);
        reports.push({ concurrency, offered: concurrency * 100, started, deferred, smallStarted, largeStarted, maxRemembered, dangerousStarts, decisions: [...decisions] });
    }
    console.log(JSON.stringify({ simulation: "seeded-watermarks", seed: 1180, reports }));
});

test("twenty pending owners recover fairly after a sharp low-memory interval", async () => {
    let clock = 0;
    const admission = new ResourceAdmissionController({ now: () => clock, requireFreshPressureSample: true });
    admission.updateSystemPressure({ ...green, lowMemorySignaled: true });
    const controllers = Array.from({ length: 20 }, () => new AbortController());
    const order = [];
    const pending = controllers.map((cancel, index) => admission.acquire({ ownerId: `owner-${index % 4}`, reservationMB: 24, signal: cancel.signal })
        .then((lease) => { order.push(index); lease.markStarted(); lease.release(); return "done"; }, (error) => error.code));
    controllers[3].abort(); controllers[11].abort();
    for (let step = 0; step < 10; step += 1) {
        clock += 100;
        admission.updateSystemPressure({ ...green, lowMemorySignaled: true });
        await Promise.resolve();
        assert.equal(order.length, 0);
    }
    admission.updateSystemPressure(green);
    const results = await Promise.all(pending);
    assert.equal(results.filter((value) => value === "done").length, 18);
    assert.equal(results.filter((value) => value === "admission_aborted").length, 2);
    assert.deepEqual(new Set(order.map((index) => index % 4)), new Set([0, 1, 2, 3]));
    assert.ok(!order.includes(3) && !order.includes(11));
    assert.equal(admission.getState().queued, 0);
    assert.equal(admission.getState().activeLeases, 0);
});
