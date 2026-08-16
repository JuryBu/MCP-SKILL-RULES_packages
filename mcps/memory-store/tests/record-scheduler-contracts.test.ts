import assert from "node:assert/strict";
import crypto from "node:crypto";

const contracts = await import("../src/record-scheduler-contracts.ts");

const admissionRequestHash = crypto.createHash("sha256")
    .update(JSON.stringify({ taskKind: "record-batch-update", requestSummary: { taskId: "task-1" }, backgroundProjection: {} }))
    .digest("hex");

const allSuccessConditions = {
    candidateSnapshotFrozen: true,
    sourceSnapshotPersisted: true,
    modelOutputBoundAndQualified: true,
    bodyAtomicallyWritten: true,
    mainIndexPublished: true,
    readerIndexConsistent: true,
    ledgerConsistent: true,
    readBackVerified: true,
};

const fence = {
    schedulerEpoch: 1,
    recordCommitEpoch: 1,
    fencingToken: 1,
    workLeaseId: "lease-1",
};

function makeLedger() {
    return {
        schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger",
        revision: 1,
        persistedHash: "ledger-hash-1",
        task: {
            taskId: "task-1",
            schedulerEpoch: 1,
            state: "Succeeded",
            terminalState: "Succeeded",
            requestMode: "batch_update",
            candidateSnapshotId: "candidate-snapshot-1",
            candidateSnapshotRevision: 1,
            admissionIdentity: {
                requestKey: "contracts:task-1",
                requestHash: admissionRequestHash,
            },
            admission: {
                state: "EnvelopeBound" as const,
                ledgerAnchor: { path: "C:\\data\\record-recovery\\record-scheduler-task-1.json", revision: 1 as const, hash: "a".repeat(64) },
                capsuleRef: { path: "C:\\data\\record-recovery\\admissions\\task-1.admission.json", hash: "b".repeat(64), byteLength: 128 },
                boundAt: "2026-07-13T00:00:00.000Z",
            },
            createdAt: "2026-07-13T00:00:00.000Z",
            updatedAt: "2026-07-13T00:05:00.000Z",
            repairState: "None",
            recordItems: { total: 1, succeeded: 1, failed: 0, unresolved: 0 },
            units: { materialized: 1, eligible: 0, running: 0, done: 1, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot: {
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            snapshotId: "candidate-snapshot-1",
            snapshotRevision: 1,
            snapshotHash: "candidate-snapshot-hash",
            snapshotRef: { path: "record-recovery/task-1/candidate-snapshot.json", hash: "candidate-snapshot-hash", byteLength: 256 },
            createdAt: "2026-07-13T00:00:00.000Z",
            requestMode: "normal",
            filters: {},
            enumerations: [{
                chain: "codex",
                complete: true,
                paginationExhausted: true,
                truncated: false,
                watermark: "candidate-watermark-1",
            }],
            candidates: [{
                conversationId: "conversation-1",
                chain: "codex",
                workspaceHash: "workspace-1",
                state: "Missing",
                evidence: ["exact-id-read"],
                evidenceHash: "candidate-evidence-hash",
            }],
        },
        sourceSnapshots: [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            sourceSnapshotId: "source-snapshot-1",
            snapshotRevision: 1,
            snapshotHash: "source-snapshot-metadata-hash",
            snapshotRef: { path: "record-recovery/task-1/source-snapshot-1.json", hash: "source-snapshot-metadata-hash", byteLength: 256 },
            conversationId: "conversation-1",
            chain: "codex",
            workspaceHash: "workspace-1",
            sourceRevision: "revision-1",
            desiredRevision: "revision-1",
            contentHash: "source-hash",
            contentRef: { path: "spool/source-1.json", hash: "source-hash", byteLength: 128 },
            formatterVersion: "1",
            readRange: { startRound: 1, endRound: 4, totalRounds: 4 },
            complete: true,
            gaps: [],
            parseWarnings: [],
        }],
        recordWork: [{
            recordWorkKey: "work-1",
            conversationId: "conversation-1",
            chain: "codex",
            workspaceHash: "workspace-1",
            desiredRevision: "revision-1",
            recordCommitEpoch: 1,
            registryRevision: 1,
            registryRef: { path: "record-recovery/record-work/work-1.json", hash: "registry-hash-1", byteLength: 128 },
            schedulerEpoch: 1,
            workLeaseId: "lease-1",
            leaseOwnerId: "owner-1",
            leaseExpiresAt: "2026-07-13T01:00:00.000Z",
            activeTaskIds: [],
            currentFencingToken: 1,
        }],
        units: [{
            unitId: "unit-1",
            taskId: "task-1",
            recordId: "conversation-1",
            state: "Succeeded",
            layer: "record",
            splitDepth: 0,
            recordWorkKey: "work-1",
            recordCommitEpoch: 1,
            dependencies: [],
            composeOrder: 0,
            sourceSnapshotId: "source-snapshot-1",
            inputHash: "input-hash",
            estimatedCost: 1,
            routePlan: ["auto", "grok"],
            attemptedProviders: ["grok"],
            retryBudget: 1,
            enqueueTime: "2026-07-13T00:00:00.000Z",
            layerEnterTime: "2026-07-13T00:00:00.000Z",
            resultRef: { path: "spool/output-1.json", hash: "output-hash", byteLength: 64 },
            coveredRevision: "revision-1",
            commitId: "commit-1",
        }],
        attempts: [{
            attemptId: "attempt-1",
            unitId: "unit-1",
            recordWorkKey: "work-1",
            originTaskIds: ["task-1"],
            activeTaskIds: [],
            state: "KnownSuccess",
            outcome: "known_success",
            provider: "grok",
            model: "grok-4.5",
            dispatchIntentAt: "2026-07-13T00:00:01.000Z",
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: "record-recovery/task-1/attempt-1.json", hash: "attempt-intent-hash", byteLength: 128 },
            startedAt: "2026-07-13T00:00:02.000Z",
            leaseExpiresAt: "2026-07-13T00:10:00.000Z",
            inputHash: "input-hash",
            outputRef: { path: "spool/output-1.json", hash: "output-hash", byteLength: 64 },
            elapsedMs: 1000,
            fence: { ...fence },
        }],
        commits: [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            commitId: "commit-1",
            taskId: "task-1",
            unitId: "unit-1",
            attemptId: "attempt-1",
            recordWorkKey: "work-1",
            sourceSnapshotId: "source-snapshot-1",
            inputHash: "input-hash",
            outputHash: "output-hash",
            qualityResult: { accepted: true },
            bodyRef: { path: "records/record-1.md", hash: "body-hash", byteLength: 256 },
            bodyHash: "body-hash",
            mainIndexRevision: "main-index-1",
            readerIndexRevision: "reader-index-1",
            mainIndexEntry: {
                revision: "main-index-1",
                entryHash: "main-entry-hash",
                commitId: "commit-1",
                recordWorkKey: "work-1",
                sourceSnapshotId: "source-snapshot-1",
                bodyHash: "body-hash",
                coveredRevision: "revision-1",
            },
            readerIndexEntry: {
                revision: "reader-index-1",
                entryHash: "reader-entry-hash",
                commitId: "commit-1",
                recordWorkKey: "work-1",
                sourceSnapshotId: "source-snapshot-1",
                bodyHash: "body-hash",
                coveredRevision: "revision-1",
            },
            ownership: { mode: "task_exclusive", ownerTaskId: "task-1" },
            beforeImage: {
                commitId: "commit-1",
                capturedAt: "2026-07-13T00:03:00.000Z",
                body: { path: "records/record-1.md", existed: false },
                mainIndexEntry: { path: "memory-index.json#conversation-1", existed: false },
                readerIndexEntry: { path: "reader-index.json#conversation-1", existed: false },
                fence: { ...fence },
            },
            coveredRevision: "revision-1",
            observedSourceRevisionAtCommit: "revision-1",
            state: "Verified",
            cleanupPhase: "NotRequired",
            verifiedAt: "2026-07-13T00:04:00.000Z",
            readBack: {
                verifiedAt: "2026-07-13T00:04:00.000Z",
                bodyHash: "body-hash",
                mainIndexRevision: "main-index-1",
                readerIndexRevision: "reader-index-1",
                mainIndexEntry: {
                    revision: "main-index-1",
                    entryHash: "main-entry-hash",
                    commitId: "commit-1",
                    recordWorkKey: "work-1",
                    sourceSnapshotId: "source-snapshot-1",
                    bodyHash: "body-hash",
                    coveredRevision: "revision-1",
                },
                readerIndexEntry: {
                    revision: "reader-index-1",
                    entryHash: "reader-entry-hash",
                    commitId: "commit-1",
                    recordWorkKey: "work-1",
                    sourceSnapshotId: "source-snapshot-1",
                    bodyHash: "body-hash",
                    coveredRevision: "revision-1",
                },
            },
            successConditions: { ...allSuccessConditions },
            fence: { ...fence },
        }],
    };
}

assert.equal(contracts.canTransitionTask("Queued", "Succeeded"), false);
assert.throws(() => contracts.assertTaskTransition("Queued", "Succeeded"), /非法状态迁移/u);
assert.throws(() => contracts.assertCandidateTransition("Fresh", "Missing"), /非法状态迁移/u);
assert.equal(contracts.canTransitionAttempt("Created", "Dispatched"), false);
assert.equal(contracts.canTransitionAttempt("Dispatched", "Discarded"), false);
assert.throws(() => contracts.assertAttemptTransition("Created", "Dispatched"), /非法状态迁移/u);

assert.equal(contracts.TASK_STATES.includes("Deferred"), true);
assert.equal(contracts.isTerminalTaskState("Deferred"), true);
assert.equal(contracts.canTransitionTask("Committing", "Deferred"), true);
assert.equal(contracts.canTransitionTask("Deferred", "Succeeded"), false);
const deferredLedger = makeLedger();
deferredLedger.task.state = "Deferred";
deferredLedger.task.terminalState = "Deferred";
assert.equal(contracts.readRecordSchedulerLedger(deferredLedger).kind, "current");
assert.equal(contracts.canReportSchedulerLedgerSuccess(deferredLedger), false);

function materializationSelection(overrides = {}) {
    return {
        sourceKey: "codex:workspace-1:conversation-1",
        chain: "codex",
        workspaceHash: "workspace-1",
        conversationId: "conversation-1",
        candidateState: "Missing",
        evidenceHash: "candidate-evidence-hash",
        ...overrides,
    };
}

function materializationMarkerRef() {
    return { path: "record-recovery/task-1/source-materialization.marker.json", hash: "materialization-marker-hash", byteLength: 64 };
}

function sourceMaterializationLedger(phase: "intent" | "sealed", outcomes: object[] = []) {
    return {
        schemaVersion: 1 as const,
        phase,
        candidateSnapshotId: "candidate-snapshot-1",
        candidateSnapshotHash: "candidate-snapshot-hash",
        selectionHash: "selection-hash-1",
        selected: [materializationSelection()],
        outcomes,
        ...(phase === "sealed" ? { markerRef: materializationMarkerRef() } : {}),
    };
}

const materializationIntentLedger = makeLedger();
materializationIntentLedger.sourceMaterialization = sourceMaterializationLedger("intent");
assert.equal(contracts.readRecordSchedulerLedger(materializationIntentLedger).kind, "current");

const materializationSealedLedger = makeLedger();
materializationSealedLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "accepted",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceSnapshotId: "source-snapshot-1",
}]);
assert.equal(contracts.readRecordSchedulerLedger(materializationSealedLedger).kind, "current");

const preparingIncrementalDshLedger = makeLedger();
preparingIncrementalDshLedger.task.state = "Preparing";
delete preparingIncrementalDshLedger.task.terminalState;
preparingIncrementalDshLedger.task.requestMode = "update";
preparingIncrementalDshLedger.task.sourceResolution = {
    phase: "frozen",
    selectedCount: 1,
    materializedCount: 0,
    unresolvedCount: 0,
    issues: [],
};
preparingIncrementalDshLedger.task.recordItems = { total: 1, succeeded: 0, failed: 0, unresolved: 0 };
preparingIncrementalDshLedger.task.units = { materialized: 0, eligible: 0, running: 0, done: 0, failed: 0 };
preparingIncrementalDshLedger.candidateSnapshot.enumerations = [{
    chain: "dsh",
    complete: false,
    paginationExhausted: false,
    truncated: true,
    watermark: "candidate-watermark-1",
    error: "dsh source discovery 未产生可判定摘要",
}];
preparingIncrementalDshLedger.candidateSnapshot.candidates[0] = {
    ...preparingIncrementalDshLedger.candidateSnapshot.candidates[0],
    chain: "dsh",
    state: "Stale",
    evidence: ["cache-generation", "exact-conversation-id", "workspace"],
    evidenceHash: "dsh-candidate-evidence-hash",
};
preparingIncrementalDshLedger.sourceSnapshots[0] = {
    ...preparingIncrementalDshLedger.sourceSnapshots[0],
    chain: "dsh",
    sourceRevision: "revision-15",
    desiredRevision: "revision-15",
    readRange: { startRound: 10, endRound: 15, totalRounds: 15 },
    complete: true,
    gaps: [],
};
preparingIncrementalDshLedger.recordWork = [];
preparingIncrementalDshLedger.units = [];
preparingIncrementalDshLedger.attempts = [];
preparingIncrementalDshLedger.commits = [];
delete preparingIncrementalDshLedger.sourceMaterialization;
assert.equal(contracts.readRecordSchedulerLedger(preparingIncrementalDshLedger).kind, "current");

const snapshotlessConflictLedger = makeLedger();
snapshotlessConflictLedger.candidateSnapshot.candidates[0].state = "Conflict";
snapshotlessConflictLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "conflict",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceRevision: "revision-2",
    contentHash: "conflicting-content-hash",
    previousContentHash: "source-hash",
    evidenceHash: "conflict-evidence-hash",
    scanId: "scan-1",
    reason: "same revision yielded different bytes",
}]);
snapshotlessConflictLedger.sourceMaterialization.selected[0].candidateState = "Conflict";
assert.equal(contracts.readRecordSchedulerLedger(snapshotlessConflictLedger).kind, "current");
assert.equal(contracts.canReportSchedulerLedgerSuccess(snapshotlessConflictLedger), false);

function assertMaterializationRejected(ledger: ReturnType<typeof makeLedger>) {
    assert.equal(contracts.readRecordSchedulerLedger(ledger).kind, "repair_required");
}

const duplicateMaterializationLedger = makeLedger();
duplicateMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("intent");
duplicateMaterializationLedger.sourceMaterialization.selected.push(materializationSelection());
assertMaterializationRejected(duplicateMaterializationLedger);

const outsideMaterializationLedger = makeLedger();
outsideMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "outside-source",
    kind: "unresolved",
    observedAt: "2026-07-13T00:01:00.000Z",
}]);
assertMaterializationRejected(outsideMaterializationLedger);

const missingOutcomeMaterializationLedger = makeLedger();
missingOutcomeMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed");
assertMaterializationRejected(missingOutcomeMaterializationLedger);

const invalidMarkerMaterializationLedger = makeLedger();
invalidMarkerMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "accepted",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceSnapshotId: "source-snapshot-1",
}]);
invalidMarkerMaterializationLedger.sourceMaterialization.markerRef.hash = "";
assertMaterializationRejected(invalidMarkerMaterializationLedger);

const missingSnapshotMaterializationLedger = makeLedger();
missingSnapshotMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "accepted",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceSnapshotId: "missing-source-snapshot",
}]);
assertMaterializationRejected(missingSnapshotMaterializationLedger);

const identityMismatchMaterializationLedger = makeLedger();
identityMismatchMaterializationLedger.candidateSnapshot.candidates.push({
    ...identityMismatchMaterializationLedger.candidateSnapshot.candidates[0],
    conversationId: "conversation-2",
    workspaceHash: "workspace-2",
    evidenceHash: "candidate-evidence-hash-2",
});
identityMismatchMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-2:conversation-2",
    kind: "accepted",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceSnapshotId: "source-snapshot-1",
}]);
identityMismatchMaterializationLedger.sourceMaterialization.selected[0] = materializationSelection({
    sourceKey: "codex:workspace-2:conversation-2",
    workspaceHash: "workspace-2",
    conversationId: "conversation-2",
    evidenceHash: "candidate-evidence-hash-2",
});
assertMaterializationRejected(identityMismatchMaterializationLedger);

const incompleteConflictMaterializationLedger = makeLedger();
incompleteConflictMaterializationLedger.candidateSnapshot.candidates[0].state = "Conflict";
incompleteConflictMaterializationLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "conflict",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceRevision: "revision-2",
    contentHash: "conflicting-content-hash",
    previousContentHash: "source-hash",
    scanId: "scan-1",
    reason: "same revision yielded different bytes",
}]);
incompleteConflictMaterializationLedger.sourceMaterialization.selected[0].candidateState = "Conflict";
assertMaterializationRejected(incompleteConflictMaterializationLedger);

function makeCancellationLedger(mode: "none" | "visible" | "compensated") {
    const ledger = makeLedger();
    ledger.task.state = "Cancelling";
    delete ledger.task.terminalState;
    ledger.task.cancelRequestedAt = "2026-07-13T00:02:00.000Z";
    if (mode === "none") {
        ledger.task.recordItems.succeeded = 0;
        ledger.units[0].state = "Cancelled";
        delete ledger.units[0].resultRef;
        delete ledger.units[0].coveredRevision;
        delete ledger.units[0].commitId;
        ledger.attempts[0].state = "Discarded";
        ledger.attempts[0].outcome = "discarded";
        ledger.commits = [];
    } else if (mode === "compensated") {
        ledger.commits[0].state = "Compensated";
        ledger.commits[0].cleanupPhase = "Verified";
        ledger.commits[0].cleanupReadBack = {
            commitId: "commit-1",
            taskId: "task-1",
            recordWorkKey: "work-1",
            verifiedAt: "2026-07-13T00:06:00.000Z",
            registryRevision: 1,
            body: { path: "records/record-1.md", taskCommitVisible: false, disposition: "absent" },
            mainIndexEntry: { path: "memory-index.json#conversation-1", taskCommitVisible: false, disposition: "absent" },
            readerIndexEntry: { path: "reader-index.json#conversation-1", taskCommitVisible: false, disposition: "absent" },
            fence: { ...fence },
        };
        ledger.attempts[0].state = "Discarded";
        ledger.attempts[0].outcome = "discarded";
    }
    return ledger;
}

const cancellationEvidence = {
    ledger: makeCancellationLedger("none"),
    taskSpoolVisible: false,
    nowMs: Date.parse("2026-07-13T02:00:00.000Z"),
};
assert.equal(contracts.canTransitionTask("Cancelling", "Cancelled"), false);
assert.equal(contracts.canTransitionTask("Cancelling", "Cancelled", { cancellationEvidence }), true);
assert.equal(contracts.isCancellationCleanupComplete({
    ...cancellationEvidence,
    ledger: makeCancellationLedger("visible"),
}), false);
assert.equal(contracts.isCancellationCleanupComplete({
    ...cancellationEvidence,
    ledger: makeCancellationLedger("compensated"),
}), true);
assert.equal(contracts.isCancellationCleanupComplete({
    ...cancellationEvidence,
    taskSpoolVisible: true,
}), false);
const ghostSucceededCancellationLedger = makeCancellationLedger("none");
ghostSucceededCancellationLedger.units[0].state = "Succeeded";
assert.equal(contracts.readRecordSchedulerLedger(ghostSucceededCancellationLedger).kind, "current");
assert.equal(contracts.isCancellationCleanupComplete({
    ledger: ghostSucceededCancellationLedger,
    taskSpoolVisible: false,
}), false);
const sharedCancellationLedger = makeCancellationLedger("visible");
sharedCancellationLedger.commits[0].ownership = { mode: "shared", ownerTaskIds: ["task-1", "task-2"] };
sharedCancellationLedger.recordWork[0].activeTaskIds = ["task-2"];
sharedCancellationLedger.attempts[0].originTaskIds = ["task-1", "task-2"];
sharedCancellationLedger.attempts[0].activeTaskIds = ["task-2"];
assert.equal(contracts.readRecordSchedulerLedger(sharedCancellationLedger).kind, "current");
assert.equal(contracts.isCancellationCleanupComplete({
    ledger: sharedCancellationLedger,
    taskSpoolVisible: false,
}), true);
const invalidSharedCompensationLedger = structuredClone(sharedCancellationLedger);
invalidSharedCompensationLedger.commits[0].state = "Compensated";
invalidSharedCompensationLedger.commits[0].cleanupPhase = "Verified";
assert.equal(contracts.readRecordSchedulerLedger(invalidSharedCompensationLedger).kind, "repair_required");
assert.equal(contracts.canTransitionTask("Cancelling", "RepairRequired"), false);
assert.equal(contracts.canTransitionCleanup("RepairRequired", "Compensating"), true);

assert.equal(contracts.canTransitionCandidate("Fresh", "Lost"), false);
const lostTarget = { chain: "codex", workspaceHash: "workspace-1", conversationId: "conversation-1" };
assert.equal(contracts.canTransitionCandidate("Fresh", "Lost", {
    target: lostTarget,
    tombstone: { ...lostTarget, observedAt: "2026-07-13T00:00:00.000Z", exactLookupSucceeded: true },
}), true);
const lostObservations = [
    { ...lostTarget, scanId: "scan-1", completedAt: "2026-07-13T00:00:00.000Z", complete: true, exactLookupSucceeded: true, found: false },
    { ...lostTarget, scanId: "scan-2", completedAt: "2026-07-13T01:00:00.000Z", complete: true, exactLookupSucceeded: true, found: false },
];
assert.equal(contracts.canTransitionCandidate("Fresh", "Lost", { target: lostTarget, observations: lostObservations }), true);
assert.equal(contracts.canTransitionCandidate("Fresh", "Lost", {
    target: lostTarget,
    observations: [{ ...lostObservations[0] }, { ...lostObservations[1], completedAt: "2026-07-13T00:59:59.999Z" }],
}), false);
assert.equal(contracts.canTransitionCandidate("Fresh", "Lost", {
    target: lostTarget,
    observations: [{ ...lostObservations[0] }, { ...lostObservations[1], conversationId: "other-conversation" }],
}), false);

const unresolved = contracts.candidateStatePolicy("Unresolved");
assert.equal(unresolved.mayAutoUpdate, false);
assert.equal(unresolved.mayAutoCleanup, false);
assert.equal(unresolved.countsAsDefiniteFailure, false);

function makeDispatchLedger() {
    const ledger = makeLedger();
    ledger.task.state = "Running";
    delete ledger.task.terminalState;
    ledger.task.recordItems.succeeded = 0;
    ledger.task.units.running = 1;
    ledger.task.units.done = 0;
    ledger.units[0].state = "Running";
    delete ledger.units[0].resultRef;
    delete ledger.units[0].coveredRevision;
    delete ledger.units[0].commitId;
    ledger.attempts[0].state = "DispatchIntentPersisted";
    ledger.attempts[0].activeTaskIds = ["task-1"];
    delete ledger.attempts[0].outcome;
    delete ledger.attempts[0].startedAt;
    delete ledger.attempts[0].leaseExpiresAt;
    delete ledger.attempts[0].outputRef;
    delete ledger.attempts[0].elapsedMs;
    ledger.recordWork[0].activeTaskIds = ["task-1"];
    ledger.commits = [];
    return ledger;
}
function makeDurabilityReceipt(ledger: ReturnType<typeof makeDispatchLedger>) {
    const attempt = ledger.attempts[0];
    const source = ledger.sourceSnapshots[0];
    const work = ledger.recordWork[0];
    return {
        verifier: "record-scheduler-store",
        verifiedAt: "2026-07-13T00:09:59.000Z",
        ledgerRevision: ledger.revision,
        ledgerHash: ledger.persistedHash,
        admissionLedgerAnchor: structuredClone(ledger.task.admission.ledgerAnchor),
        admissionCapsuleRef: structuredClone(ledger.task.admission.capsuleRef),
        candidateSnapshotId: ledger.candidateSnapshot.snapshotId,
        candidateSnapshotRevision: ledger.candidateSnapshot.snapshotRevision,
        candidateSnapshotRef: structuredClone(ledger.candidateSnapshot.snapshotRef),
        sourceSnapshotId: source.sourceSnapshotId,
        sourceSnapshotRevision: source.snapshotRevision,
        sourceSnapshotRef: structuredClone(source.snapshotRef),
        recordWorkKey: work.recordWorkKey,
        registryRevision: work.registryRevision,
        registryRef: structuredClone(work.registryRef),
        workLeaseId: work.workLeaseId,
        attemptId: attempt.attemptId,
        attemptIntentLedgerRevision: attempt.dispatchIntentLedgerRevision,
        attemptIntentRef: structuredClone(attempt.dispatchIntentRef),
        inputHash: attempt.inputHash,
        fence: structuredClone(attempt.fence),
    };
}
const dispatchLedger = makeDispatchLedger();
const durabilityReceipt = makeDurabilityReceipt(dispatchLedger);
const conflictDispatchLedger = makeDispatchLedger();
conflictDispatchLedger.sourceMaterialization = sourceMaterializationLedger("sealed", [{
    sourceKey: "codex:workspace-1:conversation-1",
    kind: "conflict",
    observedAt: "2026-07-13T00:01:00.000Z",
    sourceRevision: "revision-2",
    contentHash: "conflicting-content-hash",
    previousContentHash: "source-hash",
    evidenceHash: "conflict-evidence-hash",
    scanId: "scan-1",
    reason: "same revision yielded different bytes",
}]);
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: conflictDispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(conflictDispatchLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: dispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: { ...durabilityReceipt, ledgerHash: "unverified-ledger-hash" },
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: dispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt,
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), true);
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: dispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: {
        ...durabilityReceipt,
        registryRef: { ...durabilityReceipt.registryRef, hash: "wrong-registry-hash" },
    },
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
const staleDispatchFenceLedger = makeDispatchLedger();
staleDispatchFenceLedger.attempts[0].fence.fencingToken = 2;
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: staleDispatchFenceLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(staleDispatchFenceLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
const cancellingDispatchLedger = makeDispatchLedger();
cancellingDispatchLedger.task.state = "Cancelling";
cancellingDispatchLedger.task.cancelRequestedAt = "2026-07-13T00:09:00.000Z";
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: cancellingDispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(cancellingDispatchLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
const unresolvedDispatchBarrierLedger = makeDispatchLedger();
unresolvedDispatchBarrierLedger.candidateSnapshot.candidates[0].state = "Unresolved";
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: unresolvedDispatchBarrierLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(unresolvedDispatchBarrierLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);
const forceFreshDispatchLedger = makeDispatchLedger();
forceFreshDispatchLedger.candidateSnapshot.requestMode = "force";
forceFreshDispatchLedger.candidateSnapshot.candidates[0].state = "Fresh";
assert.equal(contracts.readRecordSchedulerLedger(forceFreshDispatchLedger).kind, "current");
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: forceFreshDispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(forceFreshDispatchLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), true);
const normalFreshDispatchLedger = makeDispatchLedger();
normalFreshDispatchLedger.candidateSnapshot.candidates[0].state = "Fresh";
assert.equal(contracts.readRecordSchedulerLedger(normalFreshDispatchLedger).kind, "repair_required");
const missingEnumerationDispatchLedger = makeDispatchLedger();
missingEnumerationDispatchLedger.candidateSnapshot.enumerations = [];
assert.equal(contracts.readRecordSchedulerLedger(missingEnumerationDispatchLedger).kind, "repair_required");
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: missingEnumerationDispatchLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(missingEnumerationDispatchLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), false);

const explicitTargetMaterializedLedger = makeDispatchLedger();
explicitTargetMaterializedLedger.candidateSnapshot.enumerations[0] = {
    chain: "codex",
    complete: false,
    paginationExhausted: false,
    truncated: true,
    watermark: "candidate-watermark-1",
    error: "explicit target host has no complete global listing",
};
explicitTargetMaterializedLedger.task.sourceResolution = {
    phase: "materialized",
    selectedCount: 1,
    materializedCount: 1,
    unresolvedCount: 0,
    issues: [],
};
assert.equal(contracts.readRecordSchedulerLedger(explicitTargetMaterializedLedger).kind, "current");
assert.equal(contracts.isAttemptDispatchAllowed({
    ledger: explicitTargetMaterializedLedger,
    attemptId: "attempt-1",
    durabilityReceipt: makeDurabilityReceipt(explicitTargetMaterializedLedger),
    nowMs: Date.parse("2026-07-13T00:10:00.000Z"),
}), true);

const incompleteBulkMaterializationLedger = structuredClone(explicitTargetMaterializedLedger);
incompleteBulkMaterializationLedger.task.sourceResolution = {
    phase: "materialized",
    selectedCount: null,
    materializedCount: 1,
    unresolvedCount: 1,
    issues: [{
        kind: "unresolved",
        chain: "codex",
        code: "source-list-incomplete",
        reason: "global source listing is incomplete",
        evidenceHashes: ["candidate-snapshot-hash"],
    }],
};
assert.equal(contracts.readRecordSchedulerLedger(incompleteBulkMaterializationLedger).kind, "repair_required");

assert.equal(contracts.hasCurrentFencingToken(fence, { ...fence }), true);
assert.equal(contracts.hasCurrentFencingToken(fence, { ...fence, fencingToken: 2 }), false);
assert.throws(() => contracts.assertCurrentFencingToken(fence, { ...fence, workLeaseId: "lease-2" }), /fencing token/u);

const snapshotRevision = { snapshotId: "source-snapshot-1", snapshotRevision: 3 };
assert.equal(contracts.matchesSnapshotRevision(snapshotRevision, { ...snapshotRevision }), true);
assert.equal(contracts.matchesSnapshotRevision(snapshotRevision, { ...snapshotRevision, snapshotRevision: 4 }), false);
assert.throws(() => contracts.assertSnapshotRevision(snapshotRevision, { ...snapshotRevision, snapshotId: "source-snapshot-2" }), /快照 revision/u);

const validLedger = makeLedger();
assert.equal(contracts.isCurrentRecordSchedulerLedger(validLedger), true);
assert.equal(contracts.evaluateRecordSuccess(validLedger, "commit-1").success, true);
const incrementalSuccessLedger = makeLedger();
incrementalSuccessLedger.sourceSnapshots[0].readRange = { startRound: 10, endRound: 15, totalRounds: 15 };
assert.equal(contracts.readRecordSchedulerLedger(incrementalSuccessLedger).kind, "current");
assert.equal(contracts.evaluateRecordSuccess(incrementalSuccessLedger, "commit-1").success, true);
assert.equal(contracts.canReportSchedulerLedgerSuccess(incrementalSuccessLedger), true);
const forceFreshSuccessLedger = makeLedger();
forceFreshSuccessLedger.candidateSnapshot.requestMode = "force";
forceFreshSuccessLedger.candidateSnapshot.candidates[0].state = "Fresh";
assert.equal(contracts.readRecordSchedulerLedger(forceFreshSuccessLedger).kind, "current");
assert.equal(contracts.evaluateRecordSuccess(forceFreshSuccessLedger, "commit-1").success, true);
assert.equal(contracts.canReportSchedulerLedgerSuccess(validLedger), true);
const validRead = contracts.readRecordSchedulerLedger(validLedger);
assert.equal(validRead.kind, "current");
if (validRead.kind === "current") {
    assert.equal(validRead.canDispatch, false);
    assert.equal(validRead.canReportSuccess, true);
}

const routeUnitLedger = makeLedger();
routeUnitLedger.units[0].layer = "provider-attempt";
routeUnitLedger.units[0].routePlan = ["grok", "agy"];
routeUnitLedger.units[0].routeCursor = 0;
routeUnitLedger.units[0].promptRecipe = {
    recipeVersion: 1,
    templateId: "contracts-route/v1",
    range: { axis: "round", start: 1, end: 4 },
    composeOrder: 0,
};
routeUnitLedger.units[0].unitAttempts = 1;
routeUnitLedger.units[0].providerAttemptCounts = { grok: 1 };
routeUnitLedger.attempts[0].retryOrdinal = 0;
routeUnitLedger.attempts[0].trafficClass = "record";
assert.equal(contracts.readRecordSchedulerLedger(routeUnitLedger).kind, "current");

const invalidRouteCursorLedger = structuredClone(routeUnitLedger);
invalidRouteCursorLedger.units[0].routeCursor = 2;
assert.equal(contracts.readRecordSchedulerLedger(invalidRouteCursorLedger).kind, "repair_required");

const invalidProviderAttemptCountLedger = structuredClone(routeUnitLedger);
invalidProviderAttemptCountLedger.units[0].providerAttemptCounts.grok = 2;
assert.equal(contracts.readRecordSchedulerLedger(invalidProviderAttemptCountLedger).kind, "repair_required");

for (const key of contracts.RECORD_SUCCESS_CONDITION_KEYS) {
    const ledger = makeLedger();
    ledger.commits[0].successConditions[key] = false;
    assert.equal(contracts.canReportSchedulerLedgerSuccess(ledger), false, `${key} 缺失时不得成功`);
}

const staleLedger = makeLedger();
staleLedger.commits[0].observedSourceRevisionAtCommit = "revision-2";
assert.equal(contracts.canReportSchedulerLedgerSuccess(staleLedger), false);
assert.equal(contracts.readRecordSchedulerLedger(staleLedger).kind, "repair_required");
staleLedger.commits[0].pendingRefresh = {
    refreshKey: "refresh-2",
    refreshTaskId: "refresh-task-2",
    sourceSnapshotId: "source-snapshot-1",
    recordWorkKey: "work-1",
    chain: "codex",
    workspaceHash: "workspace-1",
    conversationId: "conversation-1",
    fromRevision: "revision-1",
    desiredRevision: "revision-2",
    persistedAt: "2026-07-13T00:04:00.000Z",
    ledgerRevision: 1,
    ledgerRef: { path: "record-recovery/refresh-task-2.json", hash: "refresh-ledger-hash", byteLength: 128 },
    state: "Queued",
};
assert.equal(contracts.canReportSchedulerLedgerSuccess(staleLedger), true);
assert.equal(contracts.readRecordSchedulerLedger(staleLedger).kind, "current");

const coordinatedCoveredRevisionLedger = makeLedger();
coordinatedCoveredRevisionLedger.commits[0].coveredRevision = "revision-foreign";
coordinatedCoveredRevisionLedger.commits[0].mainIndexEntry.coveredRevision = "revision-foreign";
coordinatedCoveredRevisionLedger.commits[0].readerIndexEntry.coveredRevision = "revision-foreign";
coordinatedCoveredRevisionLedger.commits[0].readBack.mainIndexEntry.coveredRevision = "revision-foreign";
coordinatedCoveredRevisionLedger.commits[0].readBack.readerIndexEntry.coveredRevision = "revision-foreign";
assert.equal(contracts.readRecordSchedulerLedger(coordinatedCoveredRevisionLedger).kind, "repair_required");

const unboundIndexLedger = makeLedger();
unboundIndexLedger.commits[0].mainIndexEntry.commitId = "other-commit";
unboundIndexLedger.commits[0].readBack.mainIndexEntry.commitId = "other-commit";
assert.equal(contracts.readRecordSchedulerLedger(unboundIndexLedger).kind, "repair_required");
assert.equal(contracts.canReportSchedulerLedgerSuccess(unboundIndexLedger), false);

const falseQualityLedger = makeLedger();
falseQualityLedger.commits[0].qualityResult.accepted = false;
assert.equal(contracts.readRecordSchedulerLedger(falseQualityLedger).kind, "repair_required");

const mismatchedBodyLedger = makeLedger();
mismatchedBodyLedger.commits[0].bodyRef.hash = "other-body-hash";
assert.equal(contracts.readRecordSchedulerLedger(mismatchedBodyLedger).kind, "repair_required");
assert.equal(contracts.canReportSchedulerLedgerSuccess(mismatchedBodyLedger), false);
assert.equal(contracts.evaluateRecordSuccess(mismatchedBodyLedger, "commit-1").success, false);

const brokenReferenceLedger = makeLedger();
brokenReferenceLedger.attempts[0].unitId = "missing-unit";
assert.equal(contracts.readRecordSchedulerLedger(brokenReferenceLedger).kind, "repair_required");

const mismatchedAttemptOutcomeLedger = makeLedger();
mismatchedAttemptOutcomeLedger.attempts[0].outcome = "known_failure";
assert.equal(contracts.readRecordSchedulerLedger(mismatchedAttemptOutcomeLedger).kind, "repair_required");

const invalidCancelLedger = makeLedger();
invalidCancelLedger.task.state = "Running";
delete invalidCancelLedger.task.terminalState;
invalidCancelLedger.task.cancelRequestedAt = "2026-07-13T00:02:00.000Z";
assert.equal(contracts.readRecordSchedulerLedger(invalidCancelLedger).kind, "repair_required");

const windsurfLedger = makeLedger();
windsurfLedger.candidateSnapshot.enumerations[0].chain = "windsurf";
windsurfLedger.candidateSnapshot.candidates[0].chain = "windsurf";
windsurfLedger.sourceSnapshots[0].chain = "windsurf";
windsurfLedger.recordWork[0].chain = "windsurf";
assert.equal(contracts.readRecordSchedulerLedger(windsurfLedger).kind, "current");

const invalidProviderLedger = makeLedger();
invalidProviderLedger.attempts[0].provider = "auto";
assert.equal(contracts.readRecordSchedulerLedger(invalidProviderLedger).kind, "repair_required");

const failedUnitLedger = makeLedger();
failedUnitLedger.units[0].state = "FailedFinal";
failedUnitLedger.task.units.failed = 1;
assert.equal(contracts.canReportSchedulerLedgerSuccess(failedUnitLedger), false);
assert.equal(contracts.readRecordSchedulerLedger(failedUnitLedger).kind, "repair_required");

const zeroItemWithUnitLedger = makeCancellationLedger("none");
zeroItemWithUnitLedger.task.state = "Succeeded";
zeroItemWithUnitLedger.task.terminalState = "Succeeded";
delete zeroItemWithUnitLedger.task.cancelRequestedAt;
zeroItemWithUnitLedger.task.recordItems.total = 0;
assert.equal(contracts.canReportSchedulerLedgerSuccess(zeroItemWithUnitLedger), false);

const sourceRevisionMismatchLedger = makeLedger();
sourceRevisionMismatchLedger.sourceSnapshots[0].sourceRevision = "revision-0";
assert.equal(contracts.readRecordSchedulerLedger(sourceRevisionMismatchLedger).kind, "repair_required");

const sourceHashMismatchLedger = makeLedger();
sourceHashMismatchLedger.sourceSnapshots[0].contentRef.hash = "other-source-hash";
assert.equal(contracts.readRecordSchedulerLedger(sourceHashMismatchLedger).kind, "repair_required");

const lostCandidateLedger = makeLedger();
lostCandidateLedger.candidateSnapshot.candidates[0].state = "Lost";
assert.equal(contracts.readRecordSchedulerLedger(lostCandidateLedger).kind, "current");
assert.equal(contracts.canReportSchedulerLedgerSuccess(lostCandidateLedger), false);

const wrongRecordIdentityLedger = makeLedger();
wrongRecordIdentityLedger.units[0].recordId = "other-conversation";
assert.equal(contracts.readRecordSchedulerLedger(wrongRecordIdentityLedger).kind, "repair_required");

const unrecoverableBeforeImageLedger = makeLedger();
unrecoverableBeforeImageLedger.commits[0].state = "CleanupPending";
unrecoverableBeforeImageLedger.commits[0].cleanupPhase = "CleanupIntentPersisted";
unrecoverableBeforeImageLedger.commits[0].beforeImage.body = {
    path: "records/record-1.md",
    existed: true,
    revision: "body-before-1",
    hash: "body-before-hash",
};
assert.equal(contracts.readRecordSchedulerLedger(unrecoverableBeforeImageLedger).kind, "repair_required");

const fakeCleanupFenceLedger = makeCancellationLedger("compensated");
fakeCleanupFenceLedger.commits[0].fence.fencingToken = 2;
fakeCleanupFenceLedger.commits[0].beforeImage.fence.fencingToken = 2;
fakeCleanupFenceLedger.commits[0].cleanupReadBack.fence.fencingToken = 2;
assert.equal(contracts.readRecordSchedulerLedger(fakeCleanupFenceLedger).kind, "repair_required");
assert.equal(contracts.isCancellationCleanupComplete({ ledger: fakeCleanupFenceLedger, taskSpoolVisible: false }), false);

const mixedSupersedingProofLedger = makeCancellationLedger("compensated");
mixedSupersedingProofLedger.commits[0].cleanupReadBack.supersedingCommit = {
    commitId: "commit-2",
    recordWorkKey: "work-2",
    recordCommitEpoch: 2,
    bodyHash: "new-body-hash",
    mainIndexEntryHash: "new-main-entry-hash",
    readerIndexEntryHash: "new-reader-entry-hash",
};
mixedSupersedingProofLedger.commits[0].cleanupReadBack.body = {
    path: "records/record-1.md",
    taskCommitVisible: false,
    disposition: "superseded_by_higher_epoch",
    observedHash: "new-body-hash",
    observedRecordCommitEpoch: 2,
    observedCommitId: "commit-2",
    observedRecordWorkKey: "work-2",
};
mixedSupersedingProofLedger.commits[0].cleanupReadBack.mainIndexEntry = {
    path: "memory-index.json#conversation-1",
    taskCommitVisible: false,
    disposition: "superseded_by_higher_epoch",
    observedHash: "new-main-entry-hash",
    observedRecordCommitEpoch: 3,
    observedCommitId: "commit-3",
    observedRecordWorkKey: "work-3",
};
mixedSupersedingProofLedger.commits[0].cleanupReadBack.readerIndexEntry = {
    path: "reader-index.json#conversation-1",
    taskCommitVisible: false,
    disposition: "superseded_by_higher_epoch",
    observedHash: "new-reader-entry-hash",
    observedRecordCommitEpoch: 4,
    observedCommitId: "commit-4",
    observedRecordWorkKey: "work-4",
};
assert.equal(contracts.readRecordSchedulerLedger(mixedSupersedingProofLedger).kind, "repair_required");

const unresolvedDispatchLedger = makeLedger();
unresolvedDispatchLedger.task.state = "Running";
delete unresolvedDispatchLedger.task.terminalState;
unresolvedDispatchLedger.task.recordItems.succeeded = 0;
unresolvedDispatchLedger.task.units.done = 0;
unresolvedDispatchLedger.units[0].state = "Queued";
delete unresolvedDispatchLedger.units[0].resultRef;
delete unresolvedDispatchLedger.units[0].coveredRevision;
delete unresolvedDispatchLedger.units[0].commitId;
unresolvedDispatchLedger.attempts = [];
unresolvedDispatchLedger.commits = [];
unresolvedDispatchLedger.recordWork[0].activeTaskIds = ["task-1"];
unresolvedDispatchLedger.recordWork[0].leaseExpiresAt = "2999-07-13T00:00:00.000Z";
unresolvedDispatchLedger.candidateSnapshot.candidates[0].state = "Unresolved";
assert.equal(contracts.readRecordSchedulerLedger(unresolvedDispatchLedger).kind, "repair_required");

function makeUnknownOutcomeLedger(unknownOutcomeAt = "2026-07-13T00:10:00.000Z") {
    const ledger = makeLedger();
    const unknownOutcomeUntil = new Date(Date.parse(unknownOutcomeAt) + contracts.UNKNOWN_OUTCOME_GRACE_MS).toISOString();
    ledger.task.state = "Running";
    delete ledger.task.terminalState;
    ledger.task.recordItems.succeeded = 0;
    ledger.task.units.done = 0;
    ledger.units[0].state = "UnknownOutcome";
    delete ledger.units[0].resultRef;
    delete ledger.units[0].coveredRevision;
    delete ledger.units[0].commitId;
    ledger.attempts[0].state = "UnknownOutcome";
    ledger.attempts[0].activeTaskIds = ["task-1"];
    ledger.attempts[0].outcome = "unknown_outcome";
    ledger.attempts[0].unknownOutcomeAt = unknownOutcomeAt;
    ledger.attempts[0].unknownOutcomeUntil = unknownOutcomeUntil;
    ledger.attempts[0].unknownOutcomeGraceMs = contracts.UNKNOWN_OUTCOME_GRACE_MS;
    ledger.attempts[0].errorClass = "UnknownOutcome";
    ledger.attempts[0].providerEvidence = "rpc-sent-response-lost";
    delete ledger.attempts[0].outputRef;
    ledger.recordWork[0].activeTaskIds = ["task-1"];
    ledger.recordWork[0].leaseExpiresAt = "2999-07-13T00:00:00.000Z";
    ledger.commits = [];
    return ledger;
}

const blockingUnknownLedger = makeUnknownOutcomeLedger();
const blockingUnknownRead = contracts.readRecordSchedulerLedger(blockingUnknownLedger, { nowMs: Date.parse("2026-07-13T00:10:10.000Z") });
assert.equal(blockingUnknownRead.kind, "current");
if (blockingUnknownRead.kind === "current") assert.equal(blockingUnknownRead.canDispatch, false);
const shortUnknownWindowLedger = makeUnknownOutcomeLedger();
shortUnknownWindowLedger.attempts[0].unknownOutcomeUntil = "2026-07-13T00:10:00.001Z";
shortUnknownWindowLedger.attempts[0].unknownOutcomeGraceMs = 1;
const shortUnknownWindowRead = contracts.readRecordSchedulerLedger(shortUnknownWindowLedger, { nowMs: Date.parse("2026-07-13T00:10:01.000Z") });
assert.equal(shortUnknownWindowRead.kind, "current", "configured grace windows remain valid when their timestamps are internally consistent");
if (shortUnknownWindowRead.kind === "current") assert.equal(shortUnknownWindowRead.canDispatch, false);
const expiredUnknownRead = contracts.readRecordSchedulerLedger(makeUnknownOutcomeLedger(), { nowMs: Date.parse("2026-07-13T00:10:31.000Z") });
assert.equal(expiredUnknownRead.kind, "current");
if (expiredUnknownRead.kind === "current") assert.equal(expiredUnknownRead.canDispatch, false);
const advancedFenceLedger = makeUnknownOutcomeLedger();
advancedFenceLedger.recordWork[0].currentFencingToken = 2;
const advancedFenceRead = contracts.readRecordSchedulerLedger(advancedFenceLedger, { nowMs: Date.parse("2026-07-13T00:10:31.000Z") });
assert.equal(advancedFenceRead.kind, "repair_required", "fence advancement and UnknownOutcome settlement must be one ledger mutation");

function settleUnknownForRetry(ledger: ReturnType<typeof makeUnknownOutcomeLedger>) {
    ledger.recordWork[0].currentFencingToken = 2;
    ledger.recordWork[0].workLeaseId = "lease-2";
    ledger.units[0].state = "Queued";
    ledger.units[0].retryBudget = 0;
    ledger.attempts[0].state = "Discarded";
    ledger.attempts[0].outcome = "discarded";
    ledger.attempts[0].activeTaskIds = [];
    return ledger;
}

const settledRetryLedger = settleUnknownForRetry(makeUnknownOutcomeLedger());
const settledRetryRead = contracts.readRecordSchedulerLedger(settledRetryLedger, { nowMs: Date.parse("2026-07-13T00:10:31.000Z") });
assert.equal(settledRetryRead.kind, "current");
if (settledRetryRead.kind === "current") assert.equal(settledRetryRead.canDispatch, true);
const expiredLeaseLedger = settleUnknownForRetry(makeUnknownOutcomeLedger());
expiredLeaseLedger.recordWork[0].leaseExpiresAt = "2026-07-13T00:10:20.000Z";
const expiredLeaseRead = contracts.readRecordSchedulerLedger(expiredLeaseLedger, { nowMs: Date.parse("2026-07-13T00:10:31.000Z") });
assert.equal(expiredLeaseRead.kind, "current");
if (expiredLeaseRead.kind === "current") assert.equal(expiredLeaseRead.canDispatch, false);

const unknownUnitWithoutAttempt = makeUnknownOutcomeLedger();
unknownUnitWithoutAttempt.attempts = [];
assert.equal(contracts.readRecordSchedulerLedger(unknownUnitWithoutAttempt).kind, "repair_required");

const unknownAttemptWithWaitingUnit = makeUnknownOutcomeLedger();
unknownAttemptWithWaitingUnit.units[0].state = "WaitingRetry";
assert.equal(contracts.readRecordSchedulerLedger(unknownAttemptWithWaitingUnit).kind, "repair_required");

const duplicateFenceLedger = makeUnknownOutcomeLedger();
duplicateFenceLedger.attempts.push({
    ...structuredClone(duplicateFenceLedger.attempts[0]),
    attemptId: "attempt-2",
    state: "Dispatched",
    outcome: "dispatched",
    unknownOutcomeUntil: undefined,
    unknownOutcomeAt: undefined,
    unknownOutcomeGraceMs: undefined,
    providerEvidence: undefined,
    dispatchIntentAt: "2026-07-13T00:00:03.000Z",
});
assert.equal(contracts.readRecordSchedulerLedger(duplicateFenceLedger).kind, "repair_required");

const historicalAttemptLedger = makeUnknownOutcomeLedger();
historicalAttemptLedger.task.schedulerEpoch = 2;
historicalAttemptLedger.recordWork[0].schedulerEpoch = 2;
historicalAttemptLedger.recordWork[0].currentFencingToken = 2;
historicalAttemptLedger.recordWork[0].workLeaseId = "lease-2";
historicalAttemptLedger.recordWork[0].leaseOwnerId = "owner-2";
historicalAttemptLedger.units[0].state = "WaitingRetry";
historicalAttemptLedger.attempts[0].state = "KnownFailure";
historicalAttemptLedger.attempts[0].outcome = "known_failure";
historicalAttemptLedger.attempts[0].activeTaskIds = [];
historicalAttemptLedger.attempts[0].errorClass = "Availability";
delete historicalAttemptLedger.attempts[0].unknownOutcomeUntil;
delete historicalAttemptLedger.attempts[0].unknownOutcomeAt;
delete historicalAttemptLedger.attempts[0].unknownOutcomeGraceMs;
delete historicalAttemptLedger.attempts[0].providerEvidence;
const historicalAttemptRead = contracts.readRecordSchedulerLedger(historicalAttemptLedger, { nowMs: Date.parse("2026-07-13T00:10:31.000Z") });
assert.equal(historicalAttemptRead.kind, "current");
if (historicalAttemptRead.kind === "current") assert.equal(historicalAttemptRead.canDispatch, true);

const legacyInput = {
    version: 1,
    resumeKey: "legacy-batch",
    candidates: [],
    completed: [{ id: "conversation-1" }],
    skipped: [],
    failed: [],
};
const legacyRead = contracts.readRecordSchedulerLedger(legacyInput);
assert.equal(legacyRead.kind, "legacy");
assert.equal(legacyRead.canDispatch, false);
assert.equal(legacyRead.canRecoverDispatch, false);
assert.equal(legacyRead.canReportSuccess, false);
if (legacyRead.kind === "legacy") {
    assert.deepEqual(legacyRead.ledger.inFlight, []);
    assert.equal(legacyRead.boundary.requiresCandidateSnapshot, true);
    assert.equal(legacyRead.boundary.requiresSourceSnapshots, true);
    assert.throws(() => (legacyRead.ledger.completed as unknown[]).push({ id: "mutation" }), TypeError);
    assert.equal(legacyInput.completed.length, 1);
}

const legacyV2Read = contracts.readRecordSchedulerLedger({
    version: 2,
    resumeKey: "legacy-v1.19.3-batch",
    candidates: [],
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [],
});
assert.equal(legacyV2Read.kind, "legacy");

const futureRead = contracts.readRecordSchedulerLedger({ schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION + 1 });
assert.equal(futureRead.kind, "rejected");
if (futureRead.kind === "rejected") assert.equal(futureRead.reason, "future_schema");

for (const point of ["before-publish-intent", "after-publish-intent", "after-cleanup-intent", "before-cleanup-verify"]) {
    assert.equal(contracts.RECORD_SCHEDULER_FAULT_POINTS.includes(point), true, `${point} 必须可注入`);
}

console.log("record scheduler contracts tests passed");
