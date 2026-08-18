import assert from "node:assert/strict";
import { QueueMaterializeReentrancyError, RecordSchedulerQueue, type RecordSchedulerQueueClock, type RecordSchedulerQueueTimer } from "../src/record-scheduler-queue.ts";
import type { RecordSchedulerLedger, SchedulerUnitLedger } from "../src/record-scheduler-contracts.ts";

class FakeClock implements RecordSchedulerQueueClock {
    constructor(private currentMs = 0) {}

    now(): number {
        return this.currentMs;
    }

    advance(milliseconds: number): void {
        this.currentMs += milliseconds;
    }
}

class FakeTimer implements RecordSchedulerQueueTimer {
    private nextId = 1;
    private readonly entries = new Map<number, { at: number; callback: () => void }>();

    constructor(private readonly clock: FakeClock) {}

    setTimeout(callback: () => void, delayMs: number): number {
        const id = this.nextId;
        this.nextId += 1;
        this.entries.set(id, { at: this.clock.now() + delayMs, callback });
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.entries.delete(handle as number);
    }

    advance(milliseconds: number): void {
        this.clock.advance(milliseconds);
        while (true) {
            const due = [...this.entries.entries()]
                .filter(([, entry]) => entry.at <= this.clock.now())
                .sort((left, right) => left[1].at - right[1].at || left[0] - right[0])[0];
            if (due === undefined) return;
            this.entries.delete(due[0]);
            due[1].callback();
        }
    }
}

function iso(milliseconds: number): string {
    return new Date(milliseconds).toISOString();
}

function makeUnit(index: number, options: Partial<SchedulerUnitLedger> = {}): SchedulerUnitLedger {
    return {
        unitId: options.unitId ?? `unit-${index}`,
        taskId: "task-1",
        recordId: options.recordId ?? "record-1",
        state: options.state ?? "Queued",
        layer: options.layer ?? "record",
        parentUnitId: options.parentUnitId,
        splitDepth: options.splitDepth ?? 0,
        recordWorkKey: options.recordWorkKey ?? `work-${options.recordId ?? "record-1"}`,
        recordCommitEpoch: options.recordCommitEpoch ?? 1,
        dependencies: options.dependencies ?? [],
        continuationKey: options.continuationKey,
        composeOrder: options.composeOrder ?? index,
        sourceSnapshotId: options.sourceSnapshotId ?? "source-1",
        inputHash: options.inputHash ?? `input-${index}`,
        estimatedCost: options.estimatedCost ?? 1,
        routePlan: options.routePlan ?? ["auto"],
        attemptedProviders: options.attemptedProviders ?? [],
        retryBudget: options.retryBudget ?? 2,
        nextEligibleAt: options.nextEligibleAt,
        enqueueTime: options.enqueueTime ?? iso(0),
        layerEnterTime: options.layerEnterTime ?? iso(0),
        failureClass: options.failureClass,
        resultRef: options.resultRef,
        coveredRevision: options.coveredRevision,
        commitId: options.commitId,
    };
}

function makeLedger(units: SchedulerUnitLedger[], taskOverrides: Record<string, unknown> = {}): RecordSchedulerLedger {
    return {
        task: {
            taskId: "task-1",
            state: "Queued",
            repairState: "None",
            createdAt: iso(0),
            ...taskOverrides,
        },
        sourceSnapshots: [{
            sourceSnapshotId: "source-1",
            contentRef: { path: "spool/source-1.json", hash: "source-hash", byteLength: 512 },
        }],
        units,
    } as unknown as RecordSchedulerLedger;
}

function makeQueue(clock = new FakeClock(), maxMaterializedPrompts = 4, wakeReasons: string[] = [], materialized: string[] = []): { queue: RecordSchedulerQueue; clock: FakeClock; timer: FakeTimer } {
    const timer = new FakeTimer(clock);
    return {
        queue: new RecordSchedulerQueue({
            clock,
            timer,
            maxMaterializedPrompts,
            materializePrompt: recipe => {
                materialized.push(recipe.recipe.unitId);
                return `prompt:${recipe.recipe.unitId}`;
            },
            onWake: reason => wakeReasons.push(reason),
        }),
        clock,
        timer,
    };
}

assert.throws(() => new RecordSchedulerQueue({ maxMaterializedPrompts: 0 }), /正整数/);

{
    const materialized: string[] = [];
    const queue = new RecordSchedulerQueue({
        mode: "eligibility-only",
        materializePrompt: recipe => {
            materialized.push(recipe.recipe.unitId);
            return recipe.recipe.unitId;
        },
    });
    queue.rebuild([makeLedger([makeUnit(1), makeUnit(2)])]);
    assert.deepEqual(queue.getEligibleUnits().map(unit => unit.unitId), ["unit-1", "unit-2"]);
    assert.equal(queue.snapshot().materializedPromptCount, 0);
    assert.deepEqual(materialized, []);
}

{
    const { queue } = makeQueue();
    queue.rebuild([makeLedger(Array.from({ length: 64 }, (_, index) => makeUnit(index)))]);
    const snapshot = queue.snapshot();
    assert.equal(snapshot.logicalUnitCount, 64);
    assert.equal(snapshot.eligibleUnitCount, 64);
    assert.equal(snapshot.materializedPromptCount, 4);
    assert.equal(snapshot.waitingReasons.includes("waiting_resource"), false);
    assert.equal(snapshot.waitingReasons.includes("waiting_backoff"), false);
}

{
    const materialized: string[] = [];
    const { queue } = makeQueue(new FakeClock(), 7, [], materialized);
    queue.rebuild([makeLedger(Array.from({ length: 10_000 }, (_, index) => makeUnit(index)))]);
    const snapshot = queue.snapshot();
    assert.equal(snapshot.logicalUnitCount, 10_000);
    assert.equal(snapshot.eligibleUnitCount, 10_000);
    assert.equal(snapshot.materializedPromptCount, 7);
    assert.equal(materialized.length, 7);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.recipe.sourceSpool.path), Array(7).fill("spool/source-1.json"));
}

{
    const { queue } = makeQueue(new FakeClock(), 1);
    const first = makeUnit(1, { unitId: "first", composeOrder: 0 });
    const second = makeUnit(2, { unitId: "second", state: "Blocked", dependencies: ["first"], continuationKey: "first-summary", composeOrder: 1 });
    queue.rebuild([makeLedger([first, second])]);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["first"]);
    assert.deepEqual(queue.snapshot().waitingReasons, ["blocked_dependency"]);
    assert.equal(queue.claimNext()?.unitId, "first");
    queue.notifyDependencySucceeded("task-1", "first");
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["second"]);
    queue.rebuild([makeLedger([first, second])]);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["first"]);
    assert.deepEqual(queue.snapshot().waitingReasons, ["blocked_dependency"]);
}

{
    const { queue } = makeQueue(new FakeClock(), 1);
    const resultRef = { path: "spool/results/first.json", hash: "first-result", byteLength: 128 };
    const first = makeUnit(1, { unitId: "first", state: "ResultReady", resultRef, composeOrder: 0 });
    const second = makeUnit(2, { unitId: "second", dependencies: ["first"], continuationKey: "first-summary", composeOrder: 1 });
    queue.rebuild([makeLedger([first, second])]);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["second"], "durably spooled ResultReady dependencies must unblock continuation Units");

    const incompleteFirst = makeUnit(1, { unitId: "first", state: "ResultReady", composeOrder: 0 });
    queue.rebuild([makeLedger([incompleteFirst, second])]);
    assert.deepEqual(queue.getDispatchCandidates(), [], "ResultReady without a durable resultRef must remain blocked");
    assert.deepEqual(queue.snapshot().waitingReasons, ["blocked_dependency"]);
}

{
    const wakeReasons: string[] = [];
    const clock = new FakeClock();
    const { queue, timer } = makeQueue(clock, 2, wakeReasons);
    queue.rebuild([makeLedger([makeUnit(1, { state: "WaitingRetry", nextEligibleAt: iso(1_000) })])]);
    assert.equal(queue.snapshot().nextWakeAt, 1_000);
    assert.deepEqual(queue.getDispatchCandidates(), []);
    timer.advance(999);
    assert.equal(wakeReasons.includes("timer"), false);
    timer.advance(1);
    assert.equal(wakeReasons.includes("timer"), true);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["unit-1"]);
}

{
    const wakeReasons: string[] = [];
    const { queue } = makeQueue(new FakeClock(), 2, wakeReasons);
    queue.rebuild([makeLedger([makeUnit(1), makeUnit(2)])]);
    queue.setResources({ memorySoftLimit: true });
    assert.equal(queue.snapshot().materializedPromptCount, 0);
    assert.deepEqual(queue.snapshot().waitingReasons, ["waiting_resource"]);
    queue.setResources({ memorySoftLimit: false });
    assert.equal(queue.snapshot().materializedPromptCount, 2);
    assert.equal(wakeReasons.includes("resource"), true);
}

{
    const { queue } = makeQueue();
    const ledger = makeLedger([makeUnit(1)]);
    queue.rebuild([ledger]);
    queue.notifyCancelled("task-1");
    assert.deepEqual(queue.getDispatchCandidates(), []);
    queue.rebuild([ledger]);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["unit-1"]);
}

{
    const units = [
        makeUnit(1, { unitId: "z-last", recordId: "z-record", composeOrder: 1 }),
        makeUnit(2, { unitId: "a-last", recordId: "a-record", composeOrder: 2 }),
        makeUnit(3, { unitId: "a-first", recordId: "a-record", composeOrder: 1 }),
    ];
    const first = makeQueue(new FakeClock(), 3).queue;
    const second = makeQueue(new FakeClock(), 3).queue;
    const ledger = makeLedger(units);
    first.rebuild([ledger]);
    second.rebuild([ledger]);
    const expected = ["a-first", "a-last", "z-last"];
    assert.deepEqual(first.getDispatchCandidates().map(prompt => prompt.unitId), expected);
    assert.deepEqual(second.getDispatchCandidates().map(prompt => prompt.unitId), expected);
    assert.deepEqual(first.snapshot().recordBuckets.map(bucket => bucket.recordId), ["a-record", "z-record"]);
}

for (const operation of ["setResources", "notifyCancelled"] as const) {
    const materialized: string[] = [];
    let reenter = true;
    let continuedAfterMutation = false;
    let queue: RecordSchedulerQueue;
    queue = new RecordSchedulerQueue({
        maxMaterializedPrompts: 2,
        materializePrompt: recipe => {
            materialized.push(recipe.recipe.unitId);
            if (reenter) {
                if (operation === "setResources") queue.setResources({ memorySoftLimit: true });
                else queue.notifyCancelled("task-1");
                continuedAfterMutation = true;
            }
            return recipe.recipe.unitId;
        },
    });
    assert.throws(
        () => queue.rebuild([makeLedger([makeUnit(1), makeUnit(2)])]),
        error => error instanceof QueueMaterializeReentrancyError && error.operation === operation,
    );
    assert.deepEqual(materialized, ["unit-1"]);
    assert.equal(continuedAfterMutation, false);
    reenter = false;
    queue.rebuild([makeLedger([makeUnit(1), makeUnit(2)])]);
    assert.deepEqual(queue.getDispatchCandidates().map(prompt => prompt.unitId), ["unit-1", "unit-2"]);
}

console.log("record-scheduler queue tests passed");
