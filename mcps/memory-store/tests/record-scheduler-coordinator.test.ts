import assert from "node:assert/strict";
import {
    CoordinatorReentrancyError,
    RECORD_SCHEDULER_COORDINATOR_STATE_VERSION,
    RecordSchedulerCoordinator,
    type RecordSchedulerCoordinatorClaim,
    type RecordSchedulerCoordinatorSnapshot,
} from "../src/record-scheduler-coordinator.ts";
import { RecordSchedulerFairness } from "../src/record-scheduler-fairness.ts";
import type { RecordSchedulerLedger, SchedulerAttemptLedger, SchedulerUnitLedger } from "../src/record-scheduler-contracts.ts";
import type { RecordSchedulerQueueClock, RecordSchedulerQueueTimer } from "../src/record-scheduler-queue.ts";

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
        taskId: options.taskId ?? "task-1",
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

function makeLedger(
    units: SchedulerUnitLedger[],
    options: { taskId?: string; taskState?: string; attempts?: SchedulerAttemptLedger[]; createdAt?: number } = {},
): RecordSchedulerLedger {
    const taskId = options.taskId ?? "task-1";
    for (const unit of units) unit.taskId = taskId;
    return {
        revision: 1,
        persistedHash: "ledger-hash",
        task: {
            taskId,
            state: options.taskState ?? "Queued",
            repairState: "None",
            createdAt: iso(options.createdAt ?? 0),
        },
        sourceSnapshots: [{
            sourceSnapshotId: "source-1",
            contentRef: { path: "spool/source-1.json", hash: "source-hash", byteLength: 512 },
        }],
        units,
        attempts: options.attempts ?? [],
    } as unknown as RecordSchedulerLedger;
}

function makeSnapshot(ledgers: readonly RecordSchedulerLedger[], debts: Record<string, number> = {}): RecordSchedulerCoordinatorSnapshot {
    const fairness = new RecordSchedulerFairness();
    for (const ledger of ledgers) {
        const grouped = new Map<string, SchedulerUnitLedger[]>();
        for (const unit of ledger.units) {
            const record = grouped.get(unit.recordId) ?? [];
            record.push(unit);
            grouped.set(unit.recordId, record);
        }
        for (const [recordId, units] of grouped) {
            fairness.addRecord({
                taskId: ledger.task.taskId,
                recordId,
                taskCreatedAt: Date.parse(ledger.task.createdAt),
                serviceDebt: debts[recordId] ?? 0,
                units: units.map(unit => ({
                    unitId: unit.unitId,
                    layer: unit.layer,
                    estimatedCost: unit.estimatedCost,
                    nextEligibleAt: unit.nextEligibleAt === undefined ? undefined : Date.parse(unit.nextEligibleAt),
                    enqueueAt: Date.parse(unit.enqueueTime),
                    layerEnteredAt: Date.parse(unit.layerEnterTime),
                })),
            });
        }
    }
    fairness.advance(0);
    return {
        version: RECORD_SCHEDULER_COORDINATOR_STATE_VERSION,
        fairness: fairness.snapshot(),
        ledgerBindings: ledgers.map(ledger => ({ taskId: ledger.task.taskId, revision: ledger.revision, persistedHash: ledger.persistedHash })),
        activeClaims: [],
        repairRequired: false,
        recoveryIssues: [],
        logicalUnitCount: 0,
        activeClaimCount: 0,
        materializedPromptCount: 0,
        waitingReasons: [],
    };
}

function makeCoordinator(
    clock = new FakeClock(),
    maxMaterializedPrompts = 32,
    materialized: string[] = [],
    wakeReasons: string[] = [],
): { coordinator: RecordSchedulerCoordinator; clock: FakeClock; timer: FakeTimer } {
    const timer = new FakeTimer(clock);
    return {
        coordinator: new RecordSchedulerCoordinator({
            clock,
            timer,
            maxMaterializedPrompts,
            materializePrompt: recipe => {
                materialized.push(recipe.recipe.unitId);
                return `prompt:${recipe.recipe.unitId}`;
            },
            onWake: event => wakeReasons.push(event.reason),
        }),
        clock,
        timer,
    };
}

assert.throws(() => new RecordSchedulerCoordinator({ maxMaterializedPrompts: 0 }), /正整数/);

async function dispatch(coordinator: RecordSchedulerCoordinator): Promise<RecordSchedulerCoordinatorClaim> {
    const result = await coordinator.step(() => true);
    if (!result.dispatched) throw new Error(`Expected dispatch, got ${result.reason}`);
    assert.equal(result.dispatched, true);
    return result.claim;
}

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

function persistRunningClaim(ledgers: RecordSchedulerLedger[], claim: RecordSchedulerCoordinatorClaim): void {
    const ledger = ledgers.find(candidate => candidate.task.taskId === claim.taskId);
    assert.notEqual(ledger, undefined);
    if (ledger === undefined) return;
    const unit = ledger.units.find(candidate => candidate.unitId === claim.unitId && candidate.recordId === claim.recordId);
    assert.notEqual(unit, undefined);
    if (unit === undefined) return;
    unit.state = "Running";
    ledger.attempts.push({
        attemptId: `attempt-${claim.taskId}-${claim.unitId}`,
        unitId: claim.unitId,
        recordWorkKey: unit.recordWorkKey,
        originTaskIds: [claim.taskId],
        activeTaskIds: [claim.taskId],
        state: "DispatchIntentPersisted",
        provider: "grok",
        model: "test",
        dispatchIntentAt: iso(0),
        dispatchIntentLedgerRevision: ledger.revision,
        dispatchIntentRef: { path: `attempts/${claim.unitId}.json`, hash: claim.unitId, byteLength: 1 },
        inputHash: unit.inputHash,
        fence: { schedulerEpoch: 1, recordCommitEpoch: 1, fencingToken: 1, workLeaseId: "lease" },
    } as SchedulerAttemptLedger);
}

async function testHundredVsTenRecords(): Promise<void> {
    const units = [
        ...Array.from({ length: 100 }, (_, index) => makeUnit(index, { unitId: `large-${index}`, recordId: "large", estimatedCost: 10 })),
        ...Array.from({ length: 10 }, (_, index) => makeUnit(100 + index, { unitId: `small-${index}`, recordId: `small-${index}`, estimatedCost: 1 })),
    ];
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild([makeLedger(units)]);
    const served = await Promise.all(Array.from({ length: 11 }, () => dispatch(coordinator)));
    assert.equal(served.filter(claim => claim.recordId === "large").length, 1);
    assert.equal(new Set(served.map(claim => claim.recordId)).size, 11);
}

async function testTwoNDeadline(): Promise<void> {
    const ledger = makeLedger([
        makeUnit(1, { unitId: "debt", recordId: "debt", estimatedCost: 1 }),
        ...Array.from({ length: 3 }, (_, index) => makeUnit(10 + index, { unitId: `fast-a-${index}`, recordId: "fast-a", estimatedCost: 1 })),
        ...Array.from({ length: 3 }, (_, index) => makeUnit(20 + index, { unitId: `fast-b-${index}`, recordId: "fast-b", estimatedCost: 1 })),
    ]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator(new FakeClock(), 16);
    await coordinator.rebuild(ledgers, { snapshot: makeSnapshot(ledgers, { debt: 50 }) });
    const served: string[] = [];
    for (let index = 0; index < 6; index += 1) {
        const claim = await dispatch(coordinator);
        served.push(claim.recordId);
        persistRunningClaim(ledgers, claim);
        await coordinator.rebuild(ledgers);
    }
    assert.notEqual(served.indexOf("debt"), -1);
    assert.ok(served.indexOf("debt") < 6);
}

async function testContinuousNewRecordsCannotStarveWindow(): Promise<void> {
    const ledger = makeLedger([makeUnit(1, { unitId: "old", recordId: "old", estimatedCost: 1 })]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator(new FakeClock(), 32);
    await coordinator.rebuild(ledgers, { snapshot: makeSnapshot(ledgers, { old: 100 }) });
    let servedOld = false;
    for (let index = 0; index < 8; index += 1) {
        const claim = await dispatch(coordinator);
        servedOld ||= claim.recordId === "old";
        persistRunningClaim(ledgers, claim);
        ledger.units.push(makeUnit(100 + index, { unitId: `new-${index}`, recordId: `new-${index}`, estimatedCost: 1 }));
        await coordinator.rebuild(ledgers);
    }
    assert.equal(servedOld, true);
}

async function testSameRecordCanReceiveConsecutivePermits(): Promise<void> {
    const { coordinator } = makeCoordinator(new FakeClock(), 3);
    await coordinator.rebuild([makeLedger([
        makeUnit(1, { unitId: "same-1", recordId: "same" }),
        makeUnit(2, { unitId: "same-2", recordId: "same" }),
        makeUnit(3, { unitId: "same-3", recordId: "same" }),
    ])]);
    const claims = [await dispatch(coordinator), await dispatch(coordinator), await dispatch(coordinator)];
    assert.deepEqual(claims.map(claim => claim.recordId), ["same", "same", "same"]);
    assert.deepEqual(claims.map(claim => claim.dispatchSeq), [1, 2, 3]);
}

async function testSplitDebtStaysWithParentRecord(): Promise<void> {
    const ledger = makeLedger([
        makeUnit(1, { unitId: "child-a", recordId: "split", parentUnitId: "parent", estimatedCost: 50 }),
        makeUnit(2, { unitId: "child-b", recordId: "split", parentUnitId: "parent", estimatedCost: 50 }),
        makeUnit(3, { unitId: "peer", recordId: "peer", estimatedCost: 1 }),
    ]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild(ledgers, { snapshot: makeSnapshot(ledgers, { split: 100 }) });
    assert.equal((await dispatch(coordinator)).recordId, "peer");
}

async function testFairChoiceCannotBePollutedByQueuePromptWindow(): Promise<void> {
    const materialized: string[] = [];
    const ledger = makeLedger([
        makeUnit(1, { unitId: "low", recordId: "a-low", estimatedCost: 1 }),
        makeUnit(2, { unitId: "high", recordId: "z-high", estimatedCost: 1 }),
    ]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator(new FakeClock(), 1, materialized);
    await coordinator.rebuild(ledgers, { snapshot: makeSnapshot(ledgers, { "a-low": 100 }) });
    assert.equal((await dispatch(coordinator)).unitId, "high");
    assert.deepEqual(materialized, ["high"]);
}

async function testTenThousandUnitsStayLazy(): Promise<void> {
    const materialized: string[] = [];
    const { coordinator } = makeCoordinator(new FakeClock(), 3, materialized);
    await coordinator.rebuild([makeLedger(Array.from({ length: 10_000 }, (_, index) => makeUnit(index, { unitId: `bulk-${index}`, recordId: "bulk" })))]);
    assert.equal(coordinator.snapshot().logicalUnitCount, 10_000);
    assert.equal(coordinator.snapshot().materializedPromptCount, 0);
    assert.deepEqual(materialized, []);
    await dispatch(coordinator);
    await dispatch(coordinator);
    await dispatch(coordinator);
    assert.equal(coordinator.snapshot().materializedPromptCount, 3);
    assert.equal(materialized.length, 3);
    const blocked = await coordinator.step(() => true);
    assert.equal(blocked.dispatched, false);
    if (!blocked.dispatched) assert.equal(blocked.reason, "waiting-prompt-window");
}

async function testPermitRejectionDoesNotAdvanceOrMaterialize(): Promise<void> {
    const materialized: string[] = [];
    const { coordinator } = makeCoordinator(new FakeClock(), 2, materialized);
    await coordinator.rebuild([makeLedger([makeUnit(1)])]);
    const rejected = await coordinator.step(() => false);
    assert.equal(rejected.dispatched, false);
    if (!rejected.dispatched) assert.equal(rejected.reason, "waiting-provider");
    assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
    assert.deepEqual(materialized, []);
    assert.equal((await dispatch(coordinator)).dispatchSeq, 1);
}

async function testMaterializeFailureReleasesPermitWithoutAdvancing(): Promise<void> {
    let releaseCount = 0;
    const coordinator = new RecordSchedulerCoordinator({
        materializePrompt: () => {
            throw new Error("prompt unavailable");
        },
    });
    await coordinator.rebuild([makeLedger([makeUnit(1)])]);
    const result = await coordinator.step(() => ({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
    }));
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "prompt-unavailable");
    assert.equal(releaseCount, 1);
    assert.equal(coordinator.snapshot().activeClaimCount, 0);
    assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
}

async function testMaterializeCallbackCannotMutateCoordinator(): Promise<void> {
    for (const operation of ["setResources", "notifyCancelled"] as const) {
        const materialized: string[] = [];
        let continuedAfterMutation = false;
        let mutate = true;
        let releaseCount = 0;
        let coordinator: RecordSchedulerCoordinator;
        coordinator = new RecordSchedulerCoordinator({
            maxMaterializedPrompts: 2,
            materializePrompt: recipe => {
                materialized.push(recipe.recipe.unitId);
                if (mutate) {
                    mutate = false;
                    if (operation === "setResources") coordinator.setResources({ memorySoftLimit: true });
                    else coordinator.notifyCancelled("task-1");
                    continuedAfterMutation = true;
                }
                return recipe.recipe.unitId;
            },
        });
        await coordinator.rebuild([makeLedger([makeUnit(1), makeUnit(2)])]);
        const rejected = await coordinator.step(() => ({
            granted: true,
            release: () => {
                releaseCount += 1;
            },
        }));
        assert.equal(rejected.dispatched, false);
        if (!rejected.dispatched) assert.equal(rejected.reason, "prompt-unavailable");
        assert.equal(continuedAfterMutation, false);
        assert.equal(releaseCount, 1);
        assert.deepEqual(materialized, ["unit-1"]);
        assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
        assert.equal(coordinator.snapshot().activeClaimCount, 0);
        const recovered = await coordinator.step(() => true);
        assert.equal(recovered.dispatched, true);
        if (recovered.dispatched) assert.equal(recovered.claim.dispatchSeq, 1);
    }
}

async function testPendingPermitRechecksResourceFlip(): Promise<void> {
    let resolvePermit: ((permit: { granted: true; release: () => void }) => void) | undefined;
    let signalRequested: (() => void) | undefined;
    let releaseCount = 0;
    const materialized: string[] = [];
    const requested = new Promise<void>(resolve => {
        signalRequested = resolve;
    });
    const pendingPermit = new Promise<{ granted: true; release: () => void }>(resolve => {
        resolvePermit = resolve;
    });
    const { coordinator } = makeCoordinator(new FakeClock(), 2, materialized);
    await coordinator.rebuild([makeLedger([makeUnit(1)])]);
    const pendingStep = coordinator.step(() => {
        signalRequested?.();
        return pendingPermit;
    });
    await requested;
    coordinator.setResources({ memorySoftLimit: true });
    resolvePermit?.({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
    });
    const result = await pendingStep;
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "waiting-resource");
    assert.equal(releaseCount, 1);
    assert.deepEqual(materialized, []);
    assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
}

async function testPendingPermitRechecksQueuedRebuild(): Promise<void> {
    let resolvePermit: ((permit: { granted: true; release: () => void }) => void) | undefined;
    let signalRequested: (() => void) | undefined;
    let releaseCount = 0;
    const materialized: string[] = [];
    const requested = new Promise<void>(resolve => {
        signalRequested = resolve;
    });
    const pendingPermit = new Promise<{ granted: true; release: () => void }>(resolve => {
        resolvePermit = resolve;
    });
    const { coordinator } = makeCoordinator(new FakeClock(), 2, materialized);
    await coordinator.rebuild([makeLedger([makeUnit(1)])]);
    const pendingStep = coordinator.step(() => {
        signalRequested?.();
        return pendingPermit;
    });
    await requested;
    const rebuiltLedger = makeLedger([makeUnit(1, { state: "WaitingRetry", nextEligibleAt: iso(1_000) })]);
    const rebuild = coordinator.rebuild([rebuiltLedger]);
    resolvePermit?.({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
    });
    const result = await pendingStep;
    await rebuild;
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "candidate-stale");
    assert.equal(releaseCount, 1);
    assert.deepEqual(materialized, []);
    assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
    assert.equal(coordinator.snapshot().nextWakeAt, 1_000);
}

async function testRebuildAndDisposeReleaseExactlyOnce(): Promise<void> {
    let releaseCount = 0;
    const ledger = makeLedger([makeUnit(1)]);
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild([ledger]);
    await coordinator.step(() => ({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
    }));
    await coordinator.reconcile([ledger]);
    assert.equal(releaseCount, 1);
    await coordinator.rebuild([ledger]);
    assert.equal(releaseCount, 1);
    await coordinator.step(() => ({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
    }));
    const firstDrain = await coordinator.dispose();
    assert.equal(firstDrain.releasedClaimCount, 1);
    assert.equal(releaseCount, 2);
    const secondDrain = await coordinator.dispose();
    assert.equal(secondDrain.releasedClaimCount, 0);
    assert.equal(releaseCount, 2);
}

async function testActiveEvidenceTransfersOnDisposeWithoutRelease(): Promise<void> {
    let releaseCount = 0;
    let transferCount = 0;
    const ledger = makeLedger([makeUnit(1)]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild(ledgers);
    const result = await coordinator.step(() => ({
        granted: true,
        release: () => {
            releaseCount += 1;
        },
        transferToRecovery: claim => {
            assert.equal(claim.dispatchSeq, 1);
            transferCount += 1;
        },
    }));
    assert.equal(result.dispatched, true);
    if (!result.dispatched) return;
    persistRunningClaim(ledgers, result.claim);
    await coordinator.rebuild(ledgers);
    assert.equal(releaseCount, 0);
    const drained = await coordinator.dispose();
    assert.equal(drained.transferredClaimCount, 1);
    assert.equal(drained.releasedClaimCount, 0);
    assert.equal(transferCount, 1);
    assert.equal(releaseCount, 0);
    await coordinator.dispose();
    assert.equal(transferCount, 1);
}

async function testFailedReleaseRetainsIdentityAndRetriesWithoutDoubleDecrement(): Promise<void> {
    const ledger = makeLedger([makeUnit(1)]);
    const { coordinator } = makeCoordinator();
    let releaseCalls = 0;
    let providerPermitCount = 1;
    const decrementedPermits = new Set<string>();
    const seenClaims: Array<{ claimId: string; permitId: string }> = [];
    await coordinator.rebuild([ledger]);
    const dispatched = await coordinator.step(() => ({
        granted: true,
        permitId: "release-permit",
        release: claim => {
            releaseCalls += 1;
            seenClaims.push({ claimId: claim.claimId, permitId: claim.permitId });
            if (releaseCalls === 1) throw new Error("first release failed");
            if (!decrementedPermits.has(claim.permitId)) {
                decrementedPermits.add(claim.permitId);
                providerPermitCount -= 1;
            }
        },
    }));
    assert.equal(dispatched.dispatched, true);
    const failedDrain = await coordinator.drain();
    assert.equal(failedDrain.complete, false);
    assert.equal(failedDrain.releasedClaimCount, 0);
    assert.equal(failedDrain.successes.length, 0);
    assert.equal(failedDrain.failures.length, 1);
    assert.equal(failedDrain.failures[0]?.action, "release");
    assert.equal(coordinator.snapshot().activeClaimCount, 1);
    assert.equal(coordinator.snapshot().recoveryIssues.some(issue => issue.code === "claim-release-failed"), true);
    await coordinator.rebuild([ledger]);
    assert.equal(releaseCalls, 2);
    assert.equal(providerPermitCount, 0);
    assert.equal(coordinator.snapshot().activeClaimCount, 0);
    assert.equal(coordinator.snapshot().repairRequired, false);
    assert.deepEqual(seenClaims, [
        { claimId: seenClaims[0]?.claimId ?? "", permitId: "release-permit" },
        { claimId: seenClaims[0]?.claimId ?? "", permitId: "release-permit" },
    ]);
    assert.equal((await coordinator.drain()).complete, true);
    assert.equal((await coordinator.drain()).releasedClaimCount, 0);
    assert.equal(releaseCalls, 2);
    assert.equal(providerPermitCount, 0);
}

async function testTransferClaimsConvergeIndependentlyAndRetryOnlyFailures(): Promise<void> {
    const ledger = makeLedger([
        makeUnit(1, { unitId: "u1" }),
        makeUnit(2, { unitId: "u2" }),
    ]);
    const ledgers = [ledger];
    const { coordinator } = makeCoordinator(new FakeClock(), 2);
    const transferCalls = new Map<string, number>();
    const transferIdentities = new Map<string, string[]>();
    const recoveredPermits = new Set<string>();
    await coordinator.rebuild(ledgers);
    const first = await coordinator.step(candidate => ({
        granted: true,
        permitId: `permit-${candidate.unitId}`,
        transferToRecovery: claim => {
            const count = (transferCalls.get(claim.unitId) ?? 0) + 1;
            transferCalls.set(claim.unitId, count);
            transferIdentities.set(claim.unitId, [...(transferIdentities.get(claim.unitId) ?? []), claim.claimId]);
            if (claim.unitId === "u2" && count === 1) throw new Error("u2 transfer failed once");
            recoveredPermits.add(claim.permitId);
        },
    }));
    const second = await coordinator.step(candidate => ({
        granted: true,
        permitId: `permit-${candidate.unitId}`,
        transferToRecovery: claim => {
            const count = (transferCalls.get(claim.unitId) ?? 0) + 1;
            transferCalls.set(claim.unitId, count);
            transferIdentities.set(claim.unitId, [...(transferIdentities.get(claim.unitId) ?? []), claim.claimId]);
            if (claim.unitId === "u2" && count === 1) throw new Error("u2 transfer failed once");
            recoveredPermits.add(claim.permitId);
        },
    }));
    assert.equal(first.dispatched, true);
    assert.equal(second.dispatched, true);
    if (!first.dispatched || !second.dispatched) return;
    persistRunningClaim(ledgers, first.claim);
    persistRunningClaim(ledgers, second.claim);
    await coordinator.rebuild(ledgers);
    const firstDrain = await coordinator.drain();
    assert.equal(firstDrain.complete, false);
    assert.equal(firstDrain.transferredClaimCount, 1);
    assert.deepEqual(firstDrain.successes.map(success => success.claim.unitId), ["u1"]);
    assert.deepEqual(firstDrain.failures.map(failure => failure.claim.unitId), ["u2"]);
    assert.equal(coordinator.snapshot().activeClaims.some(claim => claim.unitId === "u1"), true);
    assert.equal(transferCalls.get("u1"), 1);
    assert.equal(transferCalls.get("u2"), 1);
    await coordinator.rebuild(ledgers);
    assert.equal(coordinator.snapshot().recoveryIssues.some(issue => issue.code === "missing-bound-fairness-snapshot"), false);
    assert.equal(transferCalls.get("u1"), 1);
    assert.equal(transferCalls.get("u2"), 1);
    const secondDrain = await coordinator.drain();
    assert.equal(secondDrain.complete, true);
    assert.equal(secondDrain.transferredClaimCount, 1);
    assert.deepEqual(secondDrain.successes.map(success => success.claim.unitId), ["u2"]);
    assert.deepEqual(secondDrain.failures, []);
    assert.equal(transferCalls.get("u1"), 1);
    assert.equal(transferCalls.get("u2"), 2);
    assert.equal(new Set(transferIdentities.get("u2")).size, 1);
    assert.deepEqual([...recoveredPermits].sort(), ["permit-u1", "permit-u2"]);
    assert.equal((await coordinator.drain()).transferredClaimCount, 0);
    assert.equal(transferCalls.get("u1"), 1);
    assert.equal(transferCalls.get("u2"), 2);
}

async function testLifecycleCallbacksRejectCoordinatorReentrancyWithoutDeadlock(): Promise<void> {
    const releaseCoordinator = makeCoordinator().coordinator;
    let releaseReentrancy: CoordinatorReentrancyError | undefined;
    await releaseCoordinator.rebuild([makeLedger([makeUnit(1)])]);
    await releaseCoordinator.step(() => ({
        granted: true,
        release: async () => {
            try {
                await releaseCoordinator.dispose();
            } catch (error) {
                assert.equal(error instanceof CoordinatorReentrancyError, true);
                if (error instanceof CoordinatorReentrancyError) releaseReentrancy = error;
            }
        },
    }));
    const released = await completesWithin(releaseCoordinator.drain());
    assert.equal(released.complete, true);
    assert.equal(released.releasedClaimCount, 1);
    assert.equal(releaseReentrancy?.operation, "dispose");
    assert.equal(releaseReentrancy?.callbackKind, "release");

    const transferLedger = makeLedger([makeUnit(1)]);
    const transferLedgers = [transferLedger];
    const transferCoordinator = makeCoordinator().coordinator;
    let transferReentrancy: CoordinatorReentrancyError | undefined;
    await transferCoordinator.rebuild(transferLedgers);
    const dispatched = await transferCoordinator.step(() => ({
        granted: true,
        transferToRecovery: async () => {
            try {
                await transferCoordinator.dispose();
            } catch (error) {
                assert.equal(error instanceof CoordinatorReentrancyError, true);
                if (error instanceof CoordinatorReentrancyError) transferReentrancy = error;
            }
        },
    }));
    assert.equal(dispatched.dispatched, true);
    if (!dispatched.dispatched) return;
    persistRunningClaim(transferLedgers, dispatched.claim);
    await transferCoordinator.rebuild(transferLedgers);
    const transferred = await completesWithin(transferCoordinator.drain());
    assert.equal(transferred.complete, true);
    assert.equal(transferred.transferredClaimCount, 1);
    assert.equal(transferReentrancy?.operation, "dispose");
    assert.equal(transferReentrancy?.callbackKind, "transfer");
}

async function testQueuedRebuildReconcilesCommittedReleaseWithoutRetry(): Promise<void> {
    const ledger = makeLedger([makeUnit(1)]);
    const { coordinator } = makeCoordinator();
    let signalReleaseStarted: (() => void) | undefined;
    let finishRelease: (() => void) | undefined;
    let releaseCalls = 0;
    let providerPermitCount = 1;
    const decremented = new Set<string>();
    const releaseStarted = new Promise<void>(resolve => {
        signalReleaseStarted = resolve;
    });
    const releaseMayFinish = new Promise<void>(resolve => {
        finishRelease = resolve;
    });
    await coordinator.rebuild([ledger]);
    await coordinator.step(() => ({
        granted: true,
        permitId: "generation-permit",
        release: async claim => {
            releaseCalls += 1;
            if (releaseCalls === 1) {
                signalReleaseStarted?.();
                await releaseMayFinish;
            }
            if (!decremented.has(claim.permitId)) {
                decremented.add(claim.permitId);
                providerPermitCount -= 1;
            }
        },
    }));
    const drain = coordinator.drain();
    await releaseStarted;
    const rebuild = coordinator.rebuild([ledger]);
    finishRelease?.();
    const staleDrain = await drain;
    await rebuild;
    assert.equal(staleDrain.complete, false);
    assert.equal(staleDrain.failures.length, 0);
    assert.equal(staleDrain.successes.length, 1);
    assert.equal(staleDrain.successes[0]?.claim.disposition, "released");
    assert.equal(releaseCalls, 1);
    assert.equal(providerPermitCount, 0);
    assert.equal(coordinator.snapshot().activeClaimCount, 0);
    assert.equal((await coordinator.drain()).complete, true);
    assert.equal(releaseCalls, 1);
}

async function testLifecycleSideEffectsNeverReverseAfterReceiptFlip(): Promise<void> {
    const releaseLedger = makeLedger([makeUnit(1)]);
    const releaseLedgers = [releaseLedger];
    const releaseCoordinator = makeCoordinator().coordinator;
    let releaseStarted: (() => void) | undefined;
    let finishRelease: (() => void) | undefined;
    let releaseCount = 0;
    let transferAfterRelease = 0;
    const releaseEntered = new Promise<void>(resolve => {
        releaseStarted = resolve;
    });
    const releaseMayFinish = new Promise<void>(resolve => {
        finishRelease = resolve;
    });
    await releaseCoordinator.rebuild(releaseLedgers);
    const releaseDispatch = await releaseCoordinator.step(() => ({
        granted: true,
        permitId: "stale-release",
        release: async claim => {
            assert.equal(claim.lifecycleDirection, "release");
            assert.equal(claim.disposition, "releasing");
            assert.equal(Number.isInteger(claim.reconcileGeneration), true);
            assert.match(claim.stateHash, /^[a-f0-9]{64}$/);
            releaseStarted?.();
            await releaseMayFinish;
            releaseCount += 1;
        },
        transferToRecovery: () => {
            transferAfterRelease += 1;
        },
    }));
    assert.equal(releaseDispatch.dispatched, true);
    if (!releaseDispatch.dispatched) return;
    const releasingDrain = releaseCoordinator.drain();
    await releaseEntered;
    persistRunningClaim(releaseLedgers, releaseDispatch.claim);
    const releaseRebuild = releaseCoordinator.rebuild(releaseLedgers);
    finishRelease?.();
    const released = await releasingDrain;
    assert.equal(released.complete, false);
    assert.equal(released.releasedClaimCount, 1);
    await releaseRebuild;
    assert.equal(releaseCount, 1);
    assert.equal(transferAfterRelease, 0);
    assert.equal(releaseCoordinator.snapshot().recoveryIssues.some(issue => issue.code === "claim-ledger-direction-mismatch"), true);
    const releaseHandoff = await releaseCoordinator.drain();
    assert.deepEqual(releaseHandoff.recoveryRequiredClaims.map(claim => claim.unitId), [releaseDispatch.claim.unitId]);
    assert.equal(transferAfterRelease, 0);

    const transferLedger = makeLedger([makeUnit(1)]);
    const transferLedgers = [transferLedger];
    const transferCoordinator = makeCoordinator().coordinator;
    let transferStarted: (() => void) | undefined;
    let finishTransfer: (() => void) | undefined;
    let transferCount = 0;
    let releaseAfterTransfer = 0;
    const transferEntered = new Promise<void>(resolve => {
        transferStarted = resolve;
    });
    const transferMayFinish = new Promise<void>(resolve => {
        finishTransfer = resolve;
    });
    await transferCoordinator.rebuild(transferLedgers);
    const transferDispatch = await transferCoordinator.step(() => ({
        granted: true,
        permitId: "stale-transfer",
        release: () => {
            releaseAfterTransfer += 1;
        },
        transferToRecovery: async claim => {
            assert.equal(claim.lifecycleDirection, "transfer");
            assert.equal(claim.disposition, "transferring");
            assert.equal(Number.isInteger(claim.reconcileGeneration), true);
            assert.match(claim.stateHash, /^[a-f0-9]{64}$/);
            transferStarted?.();
            await transferMayFinish;
            transferCount += 1;
        },
    }));
    assert.equal(transferDispatch.dispatched, true);
    if (!transferDispatch.dispatched) return;
    persistRunningClaim(transferLedgers, transferDispatch.claim);
    await transferCoordinator.rebuild(transferLedgers);
    const transferringDrain = transferCoordinator.drain();
    await transferEntered;
    transferLedger.attempts = [];
    transferLedger.units[0]!.state = "Cancelled";
    const transferRebuild = transferCoordinator.rebuild(transferLedgers);
    finishTransfer?.();
    const transferred = await transferringDrain;
    assert.equal(transferred.complete, false);
    assert.equal(transferred.transferredClaimCount, 1);
    await transferRebuild;
    assert.equal(transferCount, 1);
    assert.equal(releaseAfterTransfer, 0);
    assert.equal(transferCoordinator.snapshot().activeClaimCount, 0);
    assert.equal(transferCoordinator.snapshot().repairRequired, false);
    assert.equal((await transferCoordinator.drain()).complete, true);
    assert.equal(releaseAfterTransfer, 0);
}

async function testPartialTransferSnapshotRestoresOnlyFailedClaim(): Promise<void> {
    const ledger = makeLedger([
        makeUnit(1, { unitId: "u1" }),
        makeUnit(2, { unitId: "u2" }),
    ]);
    const ledgers = [ledger];
    const warm = makeCoordinator(new FakeClock(), 2).coordinator;
    const transferCalls = new Map<string, number>();
    const requestPermit = (candidate: { unitId: string }) => ({
        granted: true,
        permitId: `cold-${candidate.unitId}`,
        transferToRecovery: (claim: { unitId: string }) => {
            const count = (transferCalls.get(claim.unitId) ?? 0) + 1;
            transferCalls.set(claim.unitId, count);
            if (claim.unitId === "u2") throw new Error("u2 remains transfer-failed");
        },
    });
    await warm.rebuild(ledgers);
    const first = await warm.step(requestPermit);
    const second = await warm.step(requestPermit);
    assert.equal(first.dispatched, true);
    assert.equal(second.dispatched, true);
    if (!first.dispatched || !second.dispatched) return;
    persistRunningClaim(ledgers, first.claim);
    persistRunningClaim(ledgers, second.claim);
    await warm.rebuild(ledgers);
    const partialDrain = await warm.drain();
    assert.equal(partialDrain.complete, false);
    assert.deepEqual(partialDrain.successes.map(success => success.claim.unitId), ["u1"]);
    assert.deepEqual(partialDrain.failures.map(failure => failure.claim.unitId), ["u2"]);
    const persisted = warm.snapshot();
    const persistedU1 = persisted.activeClaims.find(claim => claim.unitId === "u1");
    const persistedU2 = persisted.activeClaims.find(claim => claim.unitId === "u2");
    assert.equal(persistedU1?.disposition, "recovery");
    assert.equal(persistedU1?.transferEvidence?.direction, "transfer");
    assert.match(persistedU1?.stateHash ?? "", /^[a-f0-9]{64}$/);
    assert.equal(persistedU2?.disposition, "transfer-failed");
    assert.match(persistedU2?.lifecycleError ?? "", /u2 remains transfer-failed/);
    assert.equal(persisted.repairRequired, true);

    const cold = makeCoordinator(new FakeClock(), 2).coordinator;
    await cold.rebuild(ledgers, { snapshot: persisted });
    assert.equal(cold.snapshot().repairRequired, true);
    const coldDrain = await cold.drain();
    assert.equal(coldDrain.complete, true);
    assert.deepEqual(coldDrain.recoveryRequiredClaims.map(claim => claim.unitId), ["u2"]);
    assert.equal(coldDrain.recoveryRequiredClaims[0]?.disposition, "recovery-required");
    assert.match(coldDrain.recoveryRequiredClaims[0]?.lifecycleError ?? "", /u2 remains transfer-failed/);
    assert.equal(transferCalls.get("u1"), 1);
    assert.equal(transferCalls.get("u2"), 1);

    for (const corruption of ["schema", "hash", "repair"] as const) {
        const tampered = JSON.parse(JSON.stringify(persisted)) as RecordSchedulerCoordinatorSnapshot;
        if (corruption === "schema") (tampered.activeClaims[0] as { schemaVersion: number }).schemaVersion = 999;
        else if (corruption === "hash") (tampered.activeClaims[0] as { stateHash: string }).stateHash = "0".repeat(64);
        else (tampered as { repairRequired: boolean }).repairRequired = false;
        const invalidCold = makeCoordinator(new FakeClock(), 2).coordinator;
        await invalidCold.rebuild(ledgers, { snapshot: tampered });
        const expectedCode = corruption === "repair" ? "snapshot-repair-state-mismatch" : "invalid-persisted-claim";
        assert.equal(invalidCold.snapshot().repairRequired, true);
        assert.equal(invalidCold.snapshot().recoveryIssues.some(issue => issue.code === expectedCode), true);
    }
}

async function testFailedLifecycleDirectionRemainsIrreversibleAcrossLedgerChanges(): Promise<void> {
    const releaseLedger = makeLedger([makeUnit(1)]);
    const releaseLedgers = [releaseLedger];
    const releaseCoordinator = makeCoordinator().coordinator;
    let releaseCalls = 0;
    let transferAfterReleaseFailure = 0;
    await releaseCoordinator.rebuild(releaseLedgers);
    const releaseClaim = await releaseCoordinator.step(() => ({
        granted: true,
        release: () => {
            releaseCalls += 1;
            if (releaseCalls === 1) throw new Error("release remains uncertain");
        },
        transferToRecovery: () => {
            transferAfterReleaseFailure += 1;
        },
    }));
    assert.equal(releaseClaim.dispatched, true);
    assert.equal((await releaseCoordinator.drain()).complete, false);
    if (!releaseClaim.dispatched) return;
    persistRunningClaim(releaseLedgers, releaseClaim.claim);
    await releaseCoordinator.rebuild(releaseLedgers);
    const released = await releaseCoordinator.drain();
    assert.equal(released.complete, true);
    assert.equal(released.releasedClaimCount, 1);
    assert.equal(released.transferredClaimCount, 0);
    assert.deepEqual(released.recoveryRequiredClaims.map(claim => claim.unitId), [releaseClaim.claim.unitId]);
    assert.equal(releaseCalls, 2);
    assert.equal(transferAfterReleaseFailure, 0);

    const transferLedger = makeLedger([makeUnit(1)]);
    const transferLedgers = [transferLedger];
    const transferCoordinator = makeCoordinator().coordinator;
    let failedTransfers = 0;
    let releaseAfterTransferFailure = 0;
    await transferCoordinator.rebuild(transferLedgers);
    const transferClaim = await transferCoordinator.step(() => ({
        granted: true,
        release: () => {
            releaseAfterTransferFailure += 1;
        },
        transferToRecovery: () => {
            failedTransfers += 1;
            if (failedTransfers === 1) throw new Error("transfer remains uncertain");
        },
    }));
    assert.equal(transferClaim.dispatched, true);
    if (!transferClaim.dispatched) return;
    persistRunningClaim(transferLedgers, transferClaim.claim);
    await transferCoordinator.rebuild(transferLedgers);
    assert.equal((await transferCoordinator.drain()).complete, false);
    transferLedger.attempts = [];
    transferLedger.units[0]!.state = "Cancelled";
    await transferCoordinator.rebuild(transferLedgers);
    assert.equal(failedTransfers, 1);
    assert.equal(releaseAfterTransferFailure, 0);
    const recovered = await transferCoordinator.drain();
    assert.equal(recovered.complete, true);
    assert.equal(recovered.transferredClaimCount, 1);
    assert.equal(failedTransfers, 2);
    assert.equal(releaseAfterTransferFailure, 0);
    assert.equal(transferCoordinator.snapshot().activeClaimCount, 0);
    assert.equal(transferCoordinator.snapshot().repairRequired, false);
}

async function testConcurrentStepsStayDistinctAndSequential(): Promise<void> {
    const { coordinator } = makeCoordinator(new FakeClock(), 2);
    await coordinator.rebuild([makeLedger([
        makeUnit(1, { unitId: "one" }),
        makeUnit(2, { unitId: "two" }),
    ])]);
    const results = await Promise.all([
        coordinator.step(() => true),
        coordinator.step(() => true),
    ]);
    assert.equal(results.every(result => result.dispatched), true);
    const claims = results.flatMap(result => result.dispatched ? [result.claim] : []);
    assert.deepEqual(claims.map(claim => claim.dispatchSeq), [1, 2]);
    assert.equal(new Set(claims.map(claim => claim.unitId)).size, 2);
}

async function testCancelAndRebuildDropsUndurableClaim(): Promise<void> {
    const ledger = makeLedger([makeUnit(1)]);
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild([ledger]);
    await dispatch(coordinator);
    assert.equal(coordinator.snapshot().activeClaimCount, 1);
    coordinator.notifyCancelled("task-1");
    ledger.task.state = "CancelRequested" as typeof ledger.task.state;
    await coordinator.rebuild([ledger]);
    assert.equal(coordinator.snapshot().activeClaimCount, 0);
    const result = await coordinator.step(() => true);
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "no-eligible");
}

async function testColdRecoveryPreservesBoundDispatchSeq(): Promise<void> {
    const running = makeUnit(1, { unitId: "running" });
    const queued = makeUnit(2, { unitId: "queued" });
    const ledger = makeLedger([running, queued]);
    const ledgers = [ledger];
    const warm = makeCoordinator(new FakeClock(), 2).coordinator;
    await warm.rebuild(ledgers);
    const claim = await dispatch(warm);
    assert.equal(claim.dispatchSeq, 1);
    persistRunningClaim(ledgers, claim);
    await warm.rebuild(ledgers);
    const persisted = warm.snapshot();
    assert.equal(persisted.activeClaims[0]?.dispatchSeq, 1);
    const cold = makeCoordinator(new FakeClock(), 2).coordinator;
    await cold.rebuild(ledgers, { snapshot: persisted });
    assert.equal(cold.snapshot().repairRequired, false);
    assert.equal(cold.snapshot().activeClaimCount, 1);
    assert.equal(cold.snapshot().activeClaims[0]?.dispatchSeq, 1);
    assert.equal(cold.snapshot().fairness.dispatchSeq, 1);
    assert.equal((await dispatch(cold)).dispatchSeq, 2);
}

async function testColdRecoveryWithoutBoundSnapshotIsRepairRequired(): Promise<void> {
    const running = makeUnit(1, { unitId: "running", state: "Running" });
    const ledger = makeLedger([running], {
        attempts: [{
            attemptId: "running-attempt",
            unitId: "running",
            originTaskIds: ["task-1"],
            activeTaskIds: ["task-1"],
            state: "DispatchIntentPersisted",
            dispatchIntentAt: iso(0),
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: "attempts/running.json", hash: "running", byteLength: 1 },
        } as SchedulerAttemptLedger],
    });
    const { coordinator } = makeCoordinator();
    await coordinator.rebuild([ledger]);
    assert.equal(coordinator.snapshot().repairRequired, true);
    assert.equal(coordinator.snapshot().recoveryIssues.some(issue => issue.code === "missing-bound-fairness-snapshot"), true);
    const result = await coordinator.step(() => true);
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "repair-required");
}

async function testReceiptQueuedMismatchIsRepairRequired(): Promise<void> {
    const queued = makeUnit(1, { unitId: "mismatch", state: "Queued" });
    const ledger = makeLedger([queued], {
        attempts: [{
            attemptId: "mismatch-attempt",
            unitId: "mismatch",
            originTaskIds: ["task-1"],
            activeTaskIds: ["task-1"],
            state: "Dispatched",
            dispatchIntentAt: iso(0),
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: "attempts/mismatch.json", hash: "mismatch", byteLength: 1 },
        } as SchedulerAttemptLedger],
    });
    const materialized: string[] = [];
    const { coordinator } = makeCoordinator(new FakeClock(), 2, materialized);
    await coordinator.rebuild([ledger]);
    assert.equal(coordinator.snapshot().recoveryIssues.some(issue => issue.code === "receipt-unit-state-mismatch"), true);
    const result = await coordinator.step(() => true);
    assert.equal(result.dispatched, false);
    if (!result.dispatched) assert.equal(result.reason, "repair-required");
    assert.deepEqual(materialized, []);
    assert.equal(coordinator.snapshot().fairness.dispatchSeq, 0);
}

async function testEarliestBackoffTimerAndResourceWake(): Promise<void> {
    const wakes: string[] = [];
    const clock = new FakeClock();
    const timer = new FakeTimer(clock);
    const coordinator = new RecordSchedulerCoordinator({
        clock,
        timer,
        materializePrompt: recipe => recipe.recipe.unitId,
        onWake: event => wakes.push(event.reason),
    });
    await coordinator.rebuild([makeLedger([
        makeUnit(1, { unitId: "late", state: "WaitingRetry", nextEligibleAt: iso(1_000) }),
        makeUnit(2, { unitId: "early", state: "WaitingRetry", nextEligibleAt: iso(500) }),
    ])]);
    assert.equal(coordinator.snapshot().nextWakeAt, 500);
    timer.advance(499);
    assert.equal(wakes.includes("timer"), false);
    timer.advance(1);
    assert.equal(wakes.includes("timer"), true);
    coordinator.setResources({ memorySoftLimit: true });
    const waiting = await coordinator.step(() => true);
    assert.equal(waiting.dispatched, false);
    if (!waiting.dispatched) assert.equal(waiting.reason, "waiting-resource");
    coordinator.setResources({ memorySoftLimit: false });
    assert.equal((await dispatch(coordinator)).unitId, "early");
}

await testHundredVsTenRecords();
await testTwoNDeadline();
await testContinuousNewRecordsCannotStarveWindow();
await testSameRecordCanReceiveConsecutivePermits();
await testSplitDebtStaysWithParentRecord();
await testFairChoiceCannotBePollutedByQueuePromptWindow();
await testTenThousandUnitsStayLazy();
await testPermitRejectionDoesNotAdvanceOrMaterialize();
await testMaterializeFailureReleasesPermitWithoutAdvancing();
await testMaterializeCallbackCannotMutateCoordinator();
await testPendingPermitRechecksResourceFlip();
await testPendingPermitRechecksQueuedRebuild();
await testRebuildAndDisposeReleaseExactlyOnce();
await testActiveEvidenceTransfersOnDisposeWithoutRelease();
await testFailedReleaseRetainsIdentityAndRetriesWithoutDoubleDecrement();
await testTransferClaimsConvergeIndependentlyAndRetryOnlyFailures();
await testLifecycleCallbacksRejectCoordinatorReentrancyWithoutDeadlock();
await testQueuedRebuildReconcilesCommittedReleaseWithoutRetry();
await testLifecycleSideEffectsNeverReverseAfterReceiptFlip();
await testPartialTransferSnapshotRestoresOnlyFailedClaim();
await testFailedLifecycleDirectionRemainsIrreversibleAcrossLedgerChanges();
await testConcurrentStepsStayDistinctAndSequential();
await testCancelAndRebuildDropsUndurableClaim();
await testColdRecoveryPreservesBoundDispatchSeq();
await testColdRecoveryWithoutBoundSnapshotIsRepairRequired();
await testReceiptQueuedMismatchIsRepairRequired();
await testEarliestBackoffTimerAndResourceWake();

console.log("record-scheduler coordinator tests passed");
