import assert from "node:assert/strict";
import {
    assertRecordMutationStartupRecoverySafe,
    createRecordMutationReadinessBarrier,
    recordMutationReadinessBarrier,
    RecordMutationStartupRecoveryError,
    waitForRecordMutationReadiness,
} from "../src/record-startup-barrier.ts";

function startupRecoverySummary(input: {
    generic?: Array<{ outcome: string; taskId: string; kind: string }>;
    repairRequired?: number;
    unknownOutcome?: number;
} = {}) {
    return {
        generic: { results: input.generic || [] },
        recordScheduler: {
            repairRequired: input.repairRequired || 0,
            unknownOutcome: input.unknownOutcome || 0,
        },
    };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

async function testRecoveryKeepsMutationsBlockedAfterConnect(): Promise<void> {
    const barrier = createRecordMutationReadinessBarrier();
    const recovery = deferred();
    const startup = barrier.start(() => recovery.promise);
    let mutationWasReleased = false;
    const mutation = barrier.waitForReadiness().then(() => {
        mutationWasReleased = true;
    });

    await Promise.resolve();
    assert.equal(barrier.snapshot().state, "recovering");
    assert.equal(mutationWasReleased, false, "server.connect 后、恢复仍在进行时不得放行 Record mutation");

    recovery.resolve();
    await startup;
    await mutation;
}

async function testSuccessfulRecoveryReleasesMutations(): Promise<void> {
    const barrier = createRecordMutationReadinessBarrier();
    await barrier.start(async () => undefined);
    await barrier.waitForReadiness();
    assert.deepEqual(barrier.snapshot(), { state: "ready" });
}

async function testFailedRecoveryRejectsAndPreservesReadableError(): Promise<void> {
    const barrier = createRecordMutationReadinessBarrier();
    const readiness = barrier.waitForReadiness();
    const startup = barrier.start(() => {
        throw new Error("scheduler recovery ledger is unreadable");
    });

    await assert.rejects(readiness, error => {
        assert.ok(error instanceof RecordMutationStartupRecoveryError);
        assert.equal(error.code, "RECORD_MUTATION_STARTUP_RECOVERY_FAILED");
        assert.match(error.message, /scheduler recovery ledger is unreadable/u);
        assert.match(error.message, /mutations remain blocked/u);
        return true;
    });
    await assert.rejects(startup, RecordMutationStartupRecoveryError);
    assert.deepEqual(barrier.snapshot(), {
        state: "failed",
        error: "Record mutation startup recovery failed; mutations remain blocked: scheduler recovery ledger is unreadable",
    });
}

async function testProductionHelperIsIdleBeforeBootstrapAndBlocksAfterStart(): Promise<void> {
    await waitForRecordMutationReadiness();
    const recovery = deferred();
    const startup = recordMutationReadinessBarrier.start(() => recovery.promise);
    let released = false;
    const mutation = waitForRecordMutationReadiness().then(() => {
        released = true;
    });
    await Promise.resolve();
    assert.equal(released, false);
    recovery.resolve();
    await startup;
    await mutation;
}

function testStartupRecoverySummaryBlocksOnlyUnresolvedRecordMutationState(): void {
    assert.doesNotThrow(() => assertRecordMutationStartupRecoverySafe(startupRecoverySummary({
        generic: [{ outcome: "error", taskId: "unrelated-task", kind: "conversation-export" }],
    })));
    assert.throws(
        () => assertRecordMutationStartupRecoverySafe(startupRecoverySummary({
            generic: [{ outcome: "error", taskId: "legacy-record", kind: "record-update" }],
        })),
        /legacyRecordFailures=1 \(legacy-record\)/u,
    );
    assert.throws(
        () => assertRecordMutationStartupRecoverySafe(startupRecoverySummary({ repairRequired: 2 })),
        /schedulerRepairRequired=2/u,
    );
    assert.throws(
        () => assertRecordMutationStartupRecoverySafe(startupRecoverySummary({ unknownOutcome: 1 })),
        /schedulerUnknownOutcome=1/u,
    );
}

await testRecoveryKeepsMutationsBlockedAfterConnect();
await testSuccessfulRecoveryReleasesMutations();
await testFailedRecoveryRejectsAndPreservesReadableError();
await testProductionHelperIsIdleBeforeBootstrapAndBlocksAfterStart();
testStartupRecoverySummaryBlocksOnlyUnresolvedRecordMutationState();

console.log("✅ record startup barrier tests passed");
