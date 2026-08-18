import assert from "node:assert/strict";
import {
    DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG,
    FairnessGrantReentrancyError,
    RecordSchedulerFairness,
    type FairnessCandidate,
    type FairnessRecordInput,
} from "../src/record-scheduler-fairness.ts";

async function completesWithin<Result>(promise: Promise<Result>, milliseconds = 500): Promise<Result> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<Result>((_resolve, reject) => {
                timeout = setTimeout(() => reject(new Error(`operation timed out after ${milliseconds}ms`)), milliseconds);
            }),
        ]);
    } finally {
        if (timeout !== undefined) clearTimeout(timeout);
    }
}

async function grant(scheduler: RecordSchedulerFairness, allow = true): Promise<FairnessCandidate> {
    const result = await scheduler.grantNext(() => allow);
    assert.equal(result.granted, true);
    if (!result.granted) throw new Error("Expected a granted permit");
    return result.candidate;
}

function addRecord(
    scheduler: RecordSchedulerFairness,
    input: Omit<FairnessRecordInput, "taskId">,
    taskId = "task",
): void {
    scheduler.addRecord({ taskId, ...input });
}

async function testLargeRecordSharesWithSmallRecords(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "large",
        taskCreatedAt: 0,
        units: Array.from({ length: 100 }, (_, index) => ({
            unitId: `large-${index}`,
            layer: "map",
            estimatedCost: 10,
        })),
    });
    for (let index = 0; index < 10; index += 1) {
        addRecord(scheduler, {
            recordId: `small-${index}`,
            taskCreatedAt: index + 1,
            units: [{ unitId: `small-unit-${index}`, layer: "map", estimatedCost: 1 }],
        });
    }
    scheduler.advance(0);
    const served = await Promise.all(Array.from({ length: 11 }, () => grant(scheduler)));
    assert.equal(served.filter((candidate) => candidate.recordId === "large").length, 1);
    assert.equal(new Set(served.map((candidate) => candidate.recordId)).size, 11);
}

async function testDependencyAndBackoffAreFilteredBeforeScoring(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "record",
        taskCreatedAt: 0,
        units: [
            { unitId: "ready", layer: "map", estimatedCost: 100 },
            { unitId: "backoff", layer: "map", estimatedCost: 1, nextEligibleAt: 10, enqueueAt: 0 },
            { unitId: "blocked", layer: "map", estimatedCost: 1, dependencies: ["missing-dependency"], enqueueAt: 0 },
        ],
    });
    scheduler.advance(0);
    assert.equal((await grant(scheduler)).unitId, "ready");
    scheduler.advance(10);
    assert.equal((await grant(scheduler)).unitId, "backoff");
}

async function testContinuousSmallUnitsCannotStarveOldUnit(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "record",
        taskCreatedAt: 0,
        units: [{ unitId: "old", layer: "map", estimatedCost: 100 }],
    });
    scheduler.advance(0);
    let servedOldAt: number | undefined;
    for (let index = 1; index <= 100; index += 1) {
        scheduler.advance(1);
        scheduler.addUnit("task", "record", {
            unitId: `new-${index}`,
            layer: "map",
            estimatedCost: 1,
        });
        const candidate = await grant(scheduler);
        if (candidate.unitId === "old") {
            servedOldAt = index;
            break;
        }
    }
    assert.notEqual(servedOldAt, undefined);
    assert.ok((servedOldAt ?? Number.POSITIVE_INFINITY) < 100);
}

async function testUnboundedFailureCountsCannotStarveOldUnit(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "record",
        taskCreatedAt: 0,
        units: [{ unitId: "old", layer: "map", estimatedCost: 100 }],
    });
    scheduler.advance(0);
    let servedOldAt: number | undefined;
    for (let index = 1; index <= 100; index += 1) {
        scheduler.advance(1);
        scheduler.addUnit("task", "record", {
            unitId: `failed-${index}`,
            layer: "map",
            estimatedCost: 1,
            layerFailures: Number.MAX_SAFE_INTEGER,
            totalFailures: Number.MAX_SAFE_INTEGER,
        });
        const candidate = await grant(scheduler);
        if (candidate.unitId === "old") {
            servedOldAt = index;
            break;
        }
    }
    assert.notEqual(servedOldAt, undefined);
    assert.ok((servedOldAt ?? Number.POSITIVE_INFINITY) < 100);
}

async function testSplitStormInheritsDebt(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "debt-record",
        taskCreatedAt: 0,
        units: [{ unitId: "parent", layer: "map", estimatedCost: 100 }],
    });
    addRecord(scheduler, {
        recordId: "peer-record",
        taskCreatedAt: 1,
        units: [{ unitId: "peer", layer: "map", estimatedCost: 1 }],
    });
    scheduler.advance(0);
    assert.equal((await grant(scheduler)).unitId, "parent");
    scheduler.settleUnit("task", "debt-record", "parent", { actualCost: 100, status: "failed" });
    scheduler.splitUnit("task", "debt-record", "parent", Array.from({ length: 20 }, (_, index) => ({
        unitId: `child-${index}`,
        layer: "map",
    })));
    const debtRecord = scheduler.getRecordState("task", "debt-record");
    assert.equal(debtRecord.serviceDebt, 100);
    const children = debtRecord.units.filter((unit) => unit.parentUnitId === "parent");
    assert.equal(children.length, 20);
    assert.equal(children.reduce((total, unit) => total + unit.estimatedCost, 0), 100);
    assert.equal((await grant(scheduler)).recordId, "peer-record");
}

async function testConsecutiveWinsPrechargeAndCorrectDebt(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "first",
        taskCreatedAt: 0,
        units: [
            { unitId: "first-a", layer: "map", estimatedCost: 4 },
            { unitId: "first-b", layer: "map", estimatedCost: 4 },
        ],
    });
    addRecord(scheduler, {
        recordId: "second",
        taskCreatedAt: 1,
        units: [{ unitId: "second-a", layer: "map", estimatedCost: 1 }],
    });
    scheduler.advance(0);
    assert.equal((await grant(scheduler)).recordId, "first");
    assert.equal(scheduler.getRecordState("task", "first").serviceDebt, 4);
    assert.equal((await grant(scheduler)).recordId, "second");
    scheduler.settleUnit("task", "first", "first-a", { actualCost: 2, status: "done" });
    assert.equal(scheduler.getRecordState("task", "first").serviceDebt, 2);
}

async function testTwoNBoundAndProviderDenial(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "old-debt",
        taskCreatedAt: 0,
        serviceDebt: 25,
        units: [{ unitId: "old-debt-unit", layer: "map", estimatedCost: 1 }],
    });
    for (let index = 0; index < 3; index += 1) {
        const recordId = `fast-${index}`;
        addRecord(scheduler, {
            recordId,
            taskCreatedAt: index + 1,
            units: Array.from({ length: 10 }, (_, unitIndex) => ({
                unitId: `${recordId}-unit-${unitIndex}`,
                layer: "map",
                estimatedCost: 1,
            })),
        });
    }
    scheduler.advance(0);
    assert.equal(scheduler.getRecordState("task", "old-debt").window?.deadlineSeq, 8);
    const denied = await scheduler.grantNext(() => false);
    assert.equal(denied.granted, false);
    assert.equal(scheduler.currentDispatchSeq, 0);
    assert.equal(scheduler.getRecordState("task", "old-debt").serviceDebt, 25);
    const served: string[] = [];
    for (let index = 0; index < 8; index += 1) {
        const candidate = await grant(scheduler);
        served.push(candidate.recordId);
        addRecord(scheduler, {
            recordId: `late-${index}`,
            taskCreatedAt: 100 + index,
            units: [{ unitId: `late-unit-${index}`, layer: "map", estimatedCost: 1 }],
        });
    }
    assert.equal(served[7], "old-debt");
    assert.equal(scheduler.currentDispatchSeq, 8);
}

async function testProviderDenialSkipsWithinOneHandoff(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "handoff",
        taskCreatedAt: 0,
        units: [
            { unitId: "first", layer: "map", estimatedCost: 1 },
            { unitId: "second", layer: "map", estimatedCost: 1 },
        ],
    });
    scheduler.advance(0);
    const candidates: FairnessCandidate[] = [];
    const handedOff = await scheduler.grantNext(candidate => {
        candidates.push(candidate);
        return candidates.length > 1 ? true : { granted: false, continueHandoff: true };
    });
    assert.equal(handedOff.granted, true, "provider denial must continue the same handoff with another eligible Unit");
    assert.equal(candidates.length, 2);
    assert.notEqual(candidates[0]?.unitId, candidates[1]?.unitId);
    assert.equal(scheduler.currentDispatchSeq, 1, "denied candidates must not consume dispatch sequence");
    const state = scheduler.getRecordState("task", "handoff");
    const deniedUnit = state.units.find(unit => unit.unitId === candidates[0]!.unitId);
    assert.equal(deniedUnit?.status, "queued", "denied candidates must remain queued");
    assert.equal(deniedUnit?.chargedCost, undefined, "denied candidates must not reserve estimated cost");
}

async function testRestartSnapshotKeepsStableTies(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "beta",
        taskCreatedAt: 0,
        units: [{ unitId: "beta-unit", layer: "map", estimatedCost: 1 }],
    });
    addRecord(scheduler, {
        recordId: "alpha",
        taskCreatedAt: 0,
        units: [
            { unitId: "unit-z", layer: "map", estimatedCost: 1 },
            { unitId: "unit-a", layer: "map", estimatedCost: 1 },
        ],
    });
    scheduler.advance(0);
    const snapshot = JSON.parse(JSON.stringify(scheduler.snapshot()));
    const restored = RecordSchedulerFairness.restore(snapshot, {}, DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.maxRestartElapsedMs + 1);
    const originalCandidate = await grant(scheduler);
    const restoredCandidate = await grant(restored);
    assert.deepEqual(
        { recordId: restoredCandidate.recordId, unitId: restoredCandidate.unitId },
        { recordId: originalCandidate.recordId, unitId: originalCandidate.unitId },
    );
    assert.deepEqual(
        { recordId: restoredCandidate.recordId, unitId: restoredCandidate.unitId },
        { recordId: "alpha", unitId: "unit-a" },
    );
    assert.equal(restored.nowMs, DEFAULT_RECORD_SCHEDULER_FAIRNESS_CONFIG.maxRestartElapsedMs);
}

async function testDependenciesStayWithinTaskAndRecord(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    scheduler.addRecord({
        taskId: "task-a",
        recordId: "producer",
        taskCreatedAt: 0,
        units: [{ unitId: "shared", layer: "map", estimatedCost: 1, status: "done" }],
    });
    scheduler.addRecord({
        taskId: "task-a",
        recordId: "consumer",
        taskCreatedAt: 1,
        units: [{ unitId: "blocked-by-other-record", layer: "map", estimatedCost: 1, dependencies: ["shared"] }],
    });
    scheduler.addRecord({
        taskId: "task-b",
        recordId: "producer",
        taskCreatedAt: 2,
        units: [{ unitId: "shared", layer: "map", estimatedCost: 1, status: "done" }],
    });
    scheduler.addRecord({
        taskId: "task-b",
        recordId: "consumer",
        taskCreatedAt: 3,
        units: [{ unitId: "blocked-by-other-task", layer: "map", estimatedCost: 1, dependencies: ["shared"] }],
    });
    scheduler.addRecord({
        taskId: "task-c",
        recordId: "local",
        taskCreatedAt: 4,
        units: [
            { unitId: "shared", layer: "map", estimatedCost: 1, status: "done" },
            { unitId: "locally-unblocked", layer: "map", estimatedCost: 1, dependencies: ["shared"] },
        ],
    });
    scheduler.advance(0);
    const localCandidate = await grant(scheduler);
    assert.deepEqual(
        { taskId: localCandidate.taskId, recordId: localCandidate.recordId, unitId: localCandidate.unitId },
        { taskId: "task-c", recordId: "local", unitId: "locally-unblocked" },
    );
    const noForeignUnlock = await scheduler.grantNext(() => true);
    assert.deepEqual(noForeignUnlock, { granted: false, reason: "no-eligible" });
}

function testAdvanceCreditsOnlyPostBackoffInterval(): void {
    const scheduler = new RecordSchedulerFairness();
    scheduler.addRecord({
        taskId: "task",
        recordId: "backoff",
        taskCreatedAt: 0,
        units: [{ unitId: "retry", layer: "map", estimatedCost: 1, nextEligibleAt: 500, enqueueAt: 0 }],
    });
    scheduler.advance(1_000);
    const state = scheduler.getRecordState("task", "backoff");
    assert.equal(state.cumulativeWaitingMs, 500);
    assert.equal(state.waitingCredit, 5);
}

async function testExtremeCreditsStayFiniteAndBreakTiesStably(): Promise<void> {
    const scheduler = new RecordSchedulerFairness({
        waitingCreditPerMs: Number.MAX_VALUE / 8,
        inner: { unitQueueCreditQuantumMs: Number.MIN_VALUE },
    });
    scheduler.addRecord({
        taskId: "task",
        recordId: "beta",
        taskCreatedAt: 0,
        units: [{ unitId: "unit", layer: "map", estimatedCost: 1, enqueueAt: 0 }],
    });
    scheduler.addRecord({
        taskId: "task",
        recordId: "alpha",
        taskCreatedAt: 0,
        units: [{ unitId: "unit", layer: "map", estimatedCost: 1, enqueueAt: 0 }],
    });
    for (let index = 0; index < 32; index += 1) scheduler.advance(1);
    const snapshot = scheduler.snapshot();
    assert.ok(snapshot.records.every((record) => Number.isFinite(record.waitingCredit)));
    const candidate = await grant(scheduler);
    assert.equal(candidate.recordId, "alpha");
    assert.ok(Number.isFinite(candidate.outerScore));
    assert.ok(Number.isFinite(candidate.innerScore));
    assert.ok(Number.isFinite(candidate.factors.unitQueueCredit));
}

async function testPermitCallbackGrantReentryFailsFastAndRecovers(): Promise<void> {
    const scheduler = new RecordSchedulerFairness();
    addRecord(scheduler, {
        recordId: "reentrant",
        taskCreatedAt: 0,
        units: [{ unitId: "unit", layer: "map", estimatedCost: 1 }],
    });
    await assert.rejects(
        completesWithin(scheduler.grantNext(async () => {
            await scheduler.grantNext(() => true);
            return true;
        })),
        error => error instanceof FairnessGrantReentrancyError,
    );
    assert.equal(scheduler.snapshot().dispatchSeq, 0);
    const recovered = await completesWithin(scheduler.grantNext(() => true));
    assert.equal(recovered.granted, true);
    if (recovered.granted) assert.equal(recovered.dispatchSeq, 1);
}

await testLargeRecordSharesWithSmallRecords();
await testDependencyAndBackoffAreFilteredBeforeScoring();
await testContinuousSmallUnitsCannotStarveOldUnit();
await testUnboundedFailureCountsCannotStarveOldUnit();
await testSplitStormInheritsDebt();
await testConsecutiveWinsPrechargeAndCorrectDebt();
await testTwoNBoundAndProviderDenial();
await testProviderDenialSkipsWithinOneHandoff();
await testRestartSnapshotKeepsStableTies();
await testDependenciesStayWithinTaskAndRecord();
testAdvanceCreditsOnlyPostBackoffInterval();
await testExtremeCreditsStayFiniteAndBreakTiesStably();
await testPermitCallbackGrantReentryFailsFastAndRecovers();

console.log("record-scheduler-fairness deterministic adversarial tests passed");
