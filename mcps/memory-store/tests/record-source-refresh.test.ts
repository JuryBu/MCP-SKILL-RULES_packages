import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PendingRefreshReference, RecordSourceSnapshot } from "../src/record-scheduler-contracts.ts";
import {
    RecordSourceRefreshCoordinator,
    createPendingRefreshKey,
    createPendingRefreshRecordHash,
    type AuthoritativeRevisionOrder,
    type RecordSourceRefreshBackend,
    type RecordSourceRefreshCoordinateInput,
    type RecordSourceRefreshDecision,
    type RecordSourceRefreshDurabilityReceipt,
    type RecordSourceRefreshEnsureRequest,
    type RecordSourceRefreshEnsureResult,
    type RecordSourceRefreshReadBackRequest,
    type RecordSourceRefreshReadBackResult,
    type RecordSourceRefreshReread,
    type RecordSourceRefreshRereadRequest,
    type RecordSourceRefreshRevisionOrderRequest,
    type RecordSourceRefreshRootBinding,
} from "../src/record-source-refresh.ts";
import {
    initializeRecordConversationStateStore,
    upsertRecordConversationState,
} from "../src/record-conversation-state.ts";

const IDENTITY = {
    chain: "codex" as const,
    workspaceHash: "workspace-hash",
    conversationId: "conversation-id",
};

const ROOT_A: RecordSourceRefreshRootBinding = {
    dataRootId: "data-root-a",
    rootPathHash: testHash("fake-data-root-a"),
};

const ROOT_B: RecordSourceRefreshRootBinding = {
    dataRootId: "data-root-b",
    rootPathHash: testHash("fake-data-root-b"),
};

interface StoredRefresh {
    pendingRefresh: PendingRefreshReference;
    durabilityReceipt: RecordSourceRefreshDurabilityReceipt;
}

interface SharedRefreshState {
    refreshes: Map<string, StoredRefresh>;
    nextTaskNumber: number;
    persistCount: number;
}

interface FixtureBackendOptions {
    reread: RecordSourceRefreshReread | (() => RecordSourceRefreshReread | Promise<RecordSourceRefreshReread>);
    order: AuthoritativeRevisionOrder | ((request: RecordSourceRefreshRevisionOrderRequest) => AuthoritativeRevisionOrder | Promise<AuthoritativeRevisionOrder>);
    shared?: SharedRefreshState;
    volatileSuccess?: boolean;
    failAfterPersist?: boolean;
    afterPersist?: "delete" | "corrupt";
    receiptMutator?: (receipt: RecordSourceRefreshDurabilityReceipt) => unknown;
    readBackReceiptMutator?: (receipt: RecordSourceRefreshDurabilityReceipt) => unknown;
    readBackDelayMs?: number;
}

class FixtureBackend implements RecordSourceRefreshBackend {
    readonly rereadRequests: RecordSourceRefreshRereadRequest[] = [];
    readonly orderRequests: RecordSourceRefreshRevisionOrderRequest[] = [];
    readonly ensureRequests: RecordSourceRefreshEnsureRequest[] = [];
    readonly readBackRequests: RecordSourceRefreshReadBackRequest[] = [];
    readonly shared: SharedRefreshState;
    private failAfterPersist: boolean;

    constructor(private readonly options: FixtureBackendOptions) {
        this.shared = options.shared ?? { refreshes: new Map(), nextTaskNumber: 1, persistCount: 0 };
        this.failAfterPersist = options.failAfterPersist ?? false;
    }

    async rereadCurrentSource(request: RecordSourceRefreshRereadRequest): Promise<RecordSourceRefreshReread> {
        this.rereadRequests.push(request);
        return typeof this.options.reread === "function" ? this.options.reread() : this.options.reread;
    }

    async compareAuthoritativeRevisions(request: RecordSourceRefreshRevisionOrderRequest): Promise<AuthoritativeRevisionOrder> {
        this.orderRequests.push(request);
        return typeof this.options.order === "function" ? this.options.order(request) : this.options.order;
    }

    async ensurePendingRefresh(request: RecordSourceRefreshEnsureRequest): Promise<RecordSourceRefreshEnsureResult> {
        this.ensureRequests.push(request);
        const existing = this.shared.refreshes.get(request.refreshKey);
        const stored = existing ?? makeStoredRefresh(request, this.shared.nextTaskNumber++);
        if (!existing && !this.options.volatileSuccess) {
            this.shared.refreshes.set(request.refreshKey, stored);
            this.shared.persistCount += 1;
        }

        if (this.options.afterPersist === "delete") this.shared.refreshes.delete(request.refreshKey);
        if (this.options.afterPersist === "corrupt") {
            this.shared.refreshes.set(request.refreshKey, {
                ...stored,
                pendingRefresh: { ...stored.pendingRefresh, desiredRevision: "corrupt-revision" },
            });
        }
        if (this.failAfterPersist) {
            this.failAfterPersist = false;
            throw new Error("simulated-process-crash-after-persist");
        }

        const durabilityReceipt = this.options.receiptMutator
            ? this.options.receiptMutator(clone(stored.durabilityReceipt)) as RecordSourceRefreshDurabilityReceipt
            : clone(stored.durabilityReceipt);
        return {
            disposition: existing ? "attached" : "created",
            pendingRefresh: clone(stored.pendingRefresh),
            durabilityReceipt,
        };
    }

    async readBackPendingRefresh(request: RecordSourceRefreshReadBackRequest): Promise<RecordSourceRefreshReadBackResult> {
        this.readBackRequests.push(request);
        if (this.options.readBackDelayMs) await new Promise(resolve => setTimeout(resolve, this.options.readBackDelayMs));
        const stored = this.shared.refreshes.get(request.refreshKey);
        if (!stored) return { kind: "missing", reason: "refresh-not-found" };
        const durabilityReceipt = this.options.readBackReceiptMutator
            ? this.options.readBackReceiptMutator(clone(stored.durabilityReceipt)) as RecordSourceRefreshDurabilityReceipt
            : clone(stored.durabilityReceipt);
        return {
            kind: "verified",
            readFrom: "durable-storage",
            refreshKey: request.refreshKey,
            rootBinding: clone(stored.durabilityReceipt.rootBinding),
            pendingRefresh: clone(stored.pendingRefresh),
            durabilityReceipt,
            ledger: clone(stored.durabilityReceipt.ledger),
            refreshRecordHash: createPendingRefreshRecordHash(stored.pendingRefresh),
            observedAt: "2026-07-14T00:00:01.000Z",
        };
    }
}

function makeSnapshot(revision = "revision-1", contentHash = `content-hash-${revision}`): RecordSourceSnapshot {
    return {
        schemaVersion: 5,
        sourceSnapshotId: `source-${revision}`,
        snapshotRevision: 1,
        snapshotHash: `snapshot-hash-${revision}`,
        snapshotRef: { path: `fake-root/snapshots/${revision}.json`, hash: `snapshot-hash-${revision}`, byteLength: 64 },
        conversationId: IDENTITY.conversationId,
        chain: IDENTITY.chain,
        workspaceHash: IDENTITY.workspaceHash,
        sourceRevision: revision,
        desiredRevision: revision,
        contentHash,
        contentRef: { path: `fake-root/spool/${revision}.json`, hash: contentHash, byteLength: 64 },
        formatterVersion: "formatter-1",
        readRange: { startRound: 1, endRound: 4, totalRounds: 4 },
        complete: true,
        gaps: [],
        parseWarnings: [],
    };
}

function coordinateInput(taskId: string, overrides: Partial<RecordSourceRefreshCoordinateInput> = {}): RecordSourceRefreshCoordinateInput {
    return {
        taskId,
        recordWorkKey: "work-revision-1",
        sourceSnapshot: makeSnapshot(),
        persistenceRoot: ROOT_A,
        ...overrides,
    };
}

function currentReread(
    revision: string,
    overrides: Partial<Extract<RecordSourceRefreshReread, { kind: "current" }>> = {},
): Extract<RecordSourceRefreshReread, { kind: "current" }> {
    const contentHash = overrides.contentHash ?? `content-hash-${revision}`;
    return {
        kind: "current",
        identity: IDENTITY,
        currentRevision: revision,
        contentHash,
        contentEvidence: { authority: "independent-content-hash", verified: true },
        complete: true,
        partial: false,
        cacheBypassed: true,
        errors: [],
        ...overrides,
    };
}

function unresolvedReread(): Extract<RecordSourceRefreshReread, { kind: "unresolved" }> {
    return {
        kind: "unresolved",
        identity: IDENTITY,
        complete: false,
        partial: false,
        cacheBypassed: true,
        errors: ["fake-read-failure"],
    };
}

function makeStoredRefresh(request: RecordSourceRefreshEnsureRequest, taskNumber: number): StoredRefresh {
    const ledgerRevision = request.schedulerLedgerCas ? request.schedulerLedgerCas.expectedRevision + 1 : 1;
    const ledgerRef = {
        path: `fake-root/ledgers/${taskNumber}.json`,
        hash: `ledger-hash-${taskNumber}-${ledgerRevision}`,
        byteLength: 256,
    };
    const pendingRefresh: PendingRefreshReference = {
        refreshKey: request.refreshKey,
        refreshTaskId: `refresh-task-${taskNumber}`,
        sourceSnapshotId: request.sourceSnapshot.sourceSnapshotId,
        recordWorkKey: request.recordWorkKey,
        chain: request.identity.chain,
        workspaceHash: request.identity.workspaceHash,
        conversationId: request.identity.conversationId,
        fromRevision: request.fromRevision,
        desiredRevision: request.desiredRevision,
        persistedAt: "2026-07-14T00:00:00.000Z",
        ledgerRevision,
        ledgerRef,
        state: "Queued",
    };
    const durabilityReceipt: RecordSourceRefreshDurabilityReceipt = {
        version: 1,
        refreshKey: request.refreshKey,
        rootBinding: clone(request.persistenceRoot),
        ledger: { revision: ledgerRevision, ref: clone(ledgerRef), persistedHash: ledgerRef.hash },
        refreshRecordHash: createPendingRefreshRecordHash(pendingRefresh),
        durability: {
            scope: "process-crash-hot-restart",
            temporaryFileSynced: true,
            atomicReplaceCompleted: true,
            targetFileSynced: true,
            parentDirectory: { method: "directory-fsync", durableBarrierCompleted: true },
        },
        cas: request.schedulerLedgerCas
            ? {
                scope: "scheduler-ledger",
                ledgerId: request.schedulerLedgerCas.ledgerId,
                expectedRevision: request.schedulerLedgerCas.expectedRevision,
                committedRevision: ledgerRevision,
                transactionId: `scheduler-cas-${taskNumber}`,
                commitId: request.schedulerLedgerCas.commitId,
                commitSourceFieldsIncluded: true,
            }
            : {
                scope: "refresh-ledger",
                ledgerId: `refresh-ledger-${taskNumber}`,
                expectedRevision: 0,
                committedRevision: ledgerRevision,
                transactionId: `refresh-cas-${taskNumber}`,
            },
    };
    return { pendingRefresh, durabilityReceipt };
}

async function assertConversationStateProjectionSatisfiesInvariant(
    decision: RecordSourceRefreshDecision,
    label: string,
): Promise<void> {
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "record-source-refresh-conversation-state-"));
    try {
        await initializeRecordConversationStateStore({
            dataRoot,
            authority: { kind: "first-install", authorityId: `test-${label}`, observedAt: "2026-07-14T00:00:00.000Z" },
        });
        const projection = decision.conversationState;
        const result = await upsertRecordConversationState({
            dataRoot,
            identity: projection.identity,
            expectedEntryRevision: null,
            patch: {
                latestObservedRevision: projection.observedSourceRevision,
                recordCoveredRevision: projection.recordCoveredRevision,
                state: projection.candidateState,
                pendingRefreshKey: projection.pendingRefreshKey,
            },
        });
        assert.equal(result.kind, "updated", label);
    } finally {
        fs.rmSync(dataRoot, { recursive: true, force: true });
    }
}

async function testExactlyEqualRevisionCoversCurrent(): Promise<void> {
    const backend = new FixtureBackend({ reread: currentReread("revision-1"), order: "equal" });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-equal"));

    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.candidateState, "Fresh");
    assert.equal(decision.ledgerCommit?.coveredRevision, "revision-1");
    assert.equal(decision.conversationState.observedContentHash, "content-hash-revision-1");
    assert.equal(decision.refreshPersistence, null);
    assert.equal(backend.ensureRequests.length, 0);
    assert.equal(backend.readBackRequests.length, 0);
}

async function testIncrementalSnapshotCoversCurrentWhenRevisionMatches(): Promise<void> {
    const snapshot = makeSnapshot();
    snapshot.readRange = { startRound: 10, endRound: 15, totalRounds: 15 };
    const backend = new FixtureBackend({ reread: currentReread("revision-1"), order: "equal" });
    const decision = await new RecordSourceRefreshCoordinator(backend)
        .coordinate(coordinateInput("task-equal-incremental-source", { sourceSnapshot: snapshot }));

    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.candidateState, "Fresh");
    assert.equal(decision.refreshPersistence, null);
}

async function testEqualRevisionDifferentHashFailsClosed(): Promise<void> {
    const backend = new FixtureBackend({
        reread: currentReread("revision-1", { contentHash: "different-content-hash" }),
        order: "equal",
    });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-equal-different-hash"));

    assert.equal(decision.commitAllowed, false);
    assert.equal(decision.candidateState, "Unresolved");
    assert.equal(decision.reason, "equal-revision-content-hash-mismatch");
    assert.equal(decision.ledgerCommit, null);
    assert.equal(decision.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(decision, "equal-revision-different-hash");
}

async function testContentAddressedAuthorityMustValidateBinding(): Promise<void> {
    const contentHash = "sha256:content-addressed-revision";
    const snapshot = makeSnapshot(contentHash, contentHash);
    const validBackend = new FixtureBackend({
        reread: currentReread(contentHash, {
            contentHash,
            contentEvidence: { authority: "content-addressed-revision", verified: true, revisionContentHash: contentHash },
        }),
        order: "equal",
    });
    const valid = await new RecordSourceRefreshCoordinator(validBackend).coordinate(coordinateInput("task-addressed-valid", { sourceSnapshot: snapshot }));
    assert.equal(valid.commitAllowed, true);
    assert.equal(valid.candidateState, "Fresh");

    const invalidBackend = new FixtureBackend({
        reread: currentReread(contentHash, {
            contentHash,
            contentEvidence: { authority: "content-addressed-revision", verified: true, revisionContentHash: "different-hash" },
        }),
        order: "equal",
    });
    const invalid = await new RecordSourceRefreshCoordinator(invalidBackend).coordinate(coordinateInput("task-addressed-invalid", { sourceSnapshot: snapshot }));
    assert.equal(invalid.commitAllowed, false);
    assert.equal(invalid.candidateState, "Unresolved");
    assert.equal(invalid.reason, "source-reread-not-authoritative");
}

async function testAdvancedRevisionRequiresDurableReadBack(): Promise<void> {
    const backend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced" });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-advanced"));

    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.candidateState, "Stale");
    assert.equal(decision.ledgerCommit?.coveredRevision, "revision-1");
    assert.equal(decision.conversationState.observedSourceRevision, "revision-2");
    assert.equal(decision.conversationState.recordCoveredRevision, "revision-1");
    assert.equal(decision.ledgerCommit?.pendingRefresh?.refreshKey, createPendingRefreshKey(IDENTITY, "revision-2"));
    assert.equal(decision.conversationState.pendingRefreshKey, createPendingRefreshKey(IDENTITY, "revision-2"));
    assert.equal(decision.refreshPersistence?.readBack.readFrom, "durable-storage");
    assert.equal(decision.refreshPersistence?.durabilityReceipt.durability.atomicReplaceCompleted, true);
    assert.equal(backend.ensureRequests.length, 1);
    assert.equal(backend.readBackRequests.length, 1);
    await assertConversationStateProjectionSatisfiesInvariant(decision, "advanced-revision");
}

async function testRevisionSequencesAreForwardedToAuthoritativeComparator(): Promise<void> {
    const backend = new FixtureBackend({
        reread: currentReread("revision-2", { currentRevisionSequence: 12 }),
        order: request => {
            assert.equal(request.expectedRevision, "revision-1");
            assert.equal(request.expectedRevisionSequence, 11);
            assert.equal(request.currentRevision, "revision-2");
            assert.equal(request.currentRevisionSequence, 12);
            return "advanced";
        },
    });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-sequence-forward", {
        sourceSnapshot: { ...makeSnapshot(), sourceRevisionSequence: 11 },
    }));

    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.candidateState, "Stale");
    assert.equal(backend.orderRequests.length, 1);
}

async function testVolatileBackendSuccessFailsClosed(): Promise<void> {
    const backend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", volatileSuccess: true });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-volatile"));

    assert.equal(decision.commitAllowed, false);
    assert.equal(decision.candidateState, "Unresolved");
    assert.equal(decision.reason, "pending-refresh-readback-unverified");
    assert.equal(decision.ledgerCommit, null);
    assert.equal(decision.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(decision, "volatile-readback");
    assert.equal(backend.shared.refreshes.size, 0);
    assert.equal(backend.readBackRequests.length, 1);
}

async function testForgedDurabilityReceiptsFailClosed(): Promise<void> {
    const cases: Array<{ name: string; mutate: (receipt: RecordSourceRefreshDurabilityReceipt) => unknown }> = [
        {
            name: "cross-data-root",
            mutate: receipt => ({ ...receipt, rootBinding: ROOT_B }),
        },
        {
            name: "forged-ledger-hash",
            mutate: receipt => ({ ...receipt, ledger: { ...receipt.ledger, persistedHash: "forged-hash" } }),
        },
        {
            name: "missing-atomic-barrier",
            mutate: receipt => ({ ...receipt, durability: { ...receipt.durability, atomicReplaceCompleted: false } }),
        },
    ];

    for (const entry of cases) {
        const backend = new FixtureBackend({
            reread: currentReread("revision-2"),
            order: "advanced",
            receiptMutator: entry.mutate,
        });
        const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput(`task-${entry.name}`));
        assert.equal(decision.commitAllowed, false, entry.name);
        assert.equal(decision.candidateState, "Unresolved", entry.name);
        assert.equal(decision.reason, "pending-refresh-durability-receipt-invalid", entry.name);
        assert.equal(decision.ledgerCommit, null, entry.name);
        assert.equal(decision.conversationState.pendingRefreshKey, null, entry.name);
        await assertConversationStateProjectionSatisfiesInvariant(decision, `forged-receipt-${entry.name}`);
        assert.equal(backend.readBackRequests.length, 0, entry.name);
    }
}

async function testDeletedAndCorruptReadBackFailClosed(): Promise<void> {
    for (const afterPersist of ["delete", "corrupt"] as const) {
        const backend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", afterPersist });
        const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput(`task-${afterPersist}`));
        assert.equal(decision.commitAllowed, false, afterPersist);
        assert.equal(decision.candidateState, "Unresolved", afterPersist);
        assert.equal(decision.reason, "pending-refresh-readback-unverified", afterPersist);
        assert.equal(decision.ledgerCommit, null, afterPersist);
        assert.equal(decision.conversationState.pendingRefreshKey, null, afterPersist);
        await assertConversationStateProjectionSatisfiesInvariant(decision, `corrupt-readback-${afterPersist}`);
        assert.equal(backend.readBackRequests.length, 1, afterPersist);
    }

    const transientReceiptBackend = new FixtureBackend({
        reread: currentReread("revision-2"),
        order: "advanced",
        readBackReceiptMutator: receipt => ({ ...receipt, cas: { ...receipt.cas, transactionId: "different-persisted-receipt" } }),
    });
    const transientReceipt = await new RecordSourceRefreshCoordinator(transientReceiptBackend).coordinate(coordinateInput("task-transient-receipt"));
    assert.equal(transientReceipt.commitAllowed, false);
    assert.equal(transientReceipt.reason, "pending-refresh-readback-unverified");
    assert.equal(transientReceipt.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(transientReceipt, "readback-receipt-drift");
    assert.equal(transientReceiptBackend.readBackRequests.length, 1);
}

async function testFailClosedSourceStatesAndOrdering(): Promise<void> {
    const cases: Array<{ name: string; reread: RecordSourceRefreshReread; order: AuthoritativeRevisionOrder; state: "Lost" | "Conflict" | "Unresolved" }> = [
        { name: "lost", reread: { kind: "lost", identity: IDENTITY, complete: true, partial: false, cacheBypassed: true, errors: [] }, order: "unresolved", state: "Lost" },
        { name: "conflict", reread: { kind: "conflict", identity: IDENTITY, complete: true, partial: false, cacheBypassed: true, errors: [] }, order: "unresolved", state: "Conflict" },
        { name: "unresolved", reread: unresolvedReread(), order: "unresolved", state: "Unresolved" },
        { name: "partial", reread: currentReread("revision-2", { partial: true }), order: "advanced", state: "Unresolved" },
        { name: "cache", reread: currentReread("revision-2", { cacheBypassed: false }), order: "advanced", state: "Unresolved" },
        { name: "read-error", reread: currentReread("revision-2", { errors: ["network-timeout"] }), order: "advanced", state: "Unresolved" },
        { name: "unorderable", reread: currentReread("revision-2"), order: "unresolved", state: "Unresolved" },
        { name: "backward", reread: currentReread("revision-0"), order: "behind", state: "Conflict" },
    ];

    for (const entry of cases) {
        const backend = new FixtureBackend({ reread: entry.reread, order: entry.order });
        const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput(`task-${entry.name}`));
        assert.equal(decision.commitAllowed, false, entry.name);
        assert.equal(decision.candidateState, entry.state, entry.name);
        assert.equal(decision.ledgerCommit, null, entry.name);
        assert.equal(decision.conversationState.pendingRefreshKey, null, entry.name);
        await assertConversationStateProjectionSatisfiesInvariant(decision, `blocked-${entry.name}`);
    }

    const driftBackend = new FixtureBackend({
        reread: currentReread("revision-1", { identity: { ...IDENTITY, conversationId: "other-conversation" } }),
        order: "equal",
    });
    const drift = await new RecordSourceRefreshCoordinator(driftBackend).coordinate(coordinateInput("task-identity-drift"));
    assert.equal(drift.commitAllowed, false);
    assert.equal(drift.candidateState, "Conflict");
    assert.equal(drift.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(drift, "blocked-identity-drift");
    assert.equal(driftBackend.orderRequests.length, 0);

    const throwingBackend = new FixtureBackend({ reread: () => { throw new Error("reader-unavailable"); }, order: "unresolved" });
    const failedRead = await new RecordSourceRefreshCoordinator(throwingBackend).coordinate(coordinateInput("task-read-throw"));
    assert.equal(failedRead.commitAllowed, false);
    assert.equal(failedRead.candidateState, "Unresolved");
    assert.equal(failedRead.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(failedRead, "blocked-reread-failure");
}

async function testConcurrentAttachAndVerifyOneRefresh(): Promise<void> {
    const shared: SharedRefreshState = { refreshes: new Map(), nextTaskNumber: 1, persistCount: 0 };
    const firstBackend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", shared, readBackDelayMs: 5 });
    const secondBackend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", shared, readBackDelayMs: 5 });
    const [first, second] = await Promise.all([
        new RecordSourceRefreshCoordinator(firstBackend).coordinate(coordinateInput("task-a")),
        new RecordSourceRefreshCoordinator(secondBackend).coordinate(coordinateInput("task-b")),
    ]);

    assert.equal(shared.refreshes.size, 1);
    assert.equal(shared.persistCount, 1, "同一 refresh key 的两个 task 只能持久化一次");
    assert.equal(first.commitAllowed, true);
    assert.equal(second.commitAllowed, true);
    assert.equal(first.ledgerCommit?.pendingRefresh?.refreshTaskId, second.ledgerCommit?.pendingRefresh?.refreshTaskId);
    assert.equal(firstBackend.readBackRequests.length, 1);
    assert.equal(secondBackend.readBackRequests.length, 1);
}

async function testCrashRetryAndDifferentRevisions(): Promise<void> {
    const shared: SharedRefreshState = { refreshes: new Map(), nextTaskNumber: 1, persistCount: 0 };
    const crashingBackend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", shared, failAfterPersist: true });
    const crashed = await new RecordSourceRefreshCoordinator(crashingBackend).coordinate(coordinateInput("task-crashed"));
    assert.equal(crashed.commitAllowed, false);
    assert.equal(shared.refreshes.size, 1);

    const restartedBackend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced", shared });
    const restarted = await new RecordSourceRefreshCoordinator(restartedBackend).coordinate(coordinateInput("task-restarted"));
    assert.equal(restarted.commitAllowed, true);
    assert.equal(restarted.candidateState, "Stale");
    assert.equal(shared.refreshes.size, 1);

    const revisionThreeBackend = new FixtureBackend({ reread: currentReread("revision-3"), order: "advanced", shared });
    const revisionThree = await new RecordSourceRefreshCoordinator(revisionThreeBackend).coordinate(coordinateInput("task-r3"));
    assert.equal(revisionThree.commitAllowed, true);
    assert.equal(shared.refreshes.size, 2);
    assert.notEqual(restarted.ledgerCommit?.pendingRefresh?.refreshKey, revisionThree.ledgerCommit?.pendingRefresh?.refreshKey);
}

async function testGenerationAppendCannotLoseRefresh(): Promise<void> {
    let appendObserved = false;
    const backend = new FixtureBackend({
        reread: () => {
            appendObserved = true;
            return currentReread("revision-2");
        },
        order: "advanced",
    });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-generation-append"));

    assert.equal(appendObserved, true);
    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.candidateState, "Stale");
    assert.equal(decision.ledgerCommit?.coveredRevision, "revision-1");
    assert.equal(backend.shared.refreshes.has(createPendingRefreshKey(IDENTITY, "revision-2")), true);
}

async function testSchedulerLedgerCasBarrierIsBindable(): Promise<void> {
    const schedulerLedgerCas = {
        mode: "scheduler-ledger-cas" as const,
        ledgerId: "scheduler-task-ledger",
        expectedRevision: 7,
        commitId: "commit-1",
    };
    const backend = new FixtureBackend({ reread: currentReread("revision-2"), order: "advanced" });
    const decision = await new RecordSourceRefreshCoordinator(backend).coordinate(coordinateInput("task-scheduler-cas", {
        schedulerLedgerCas,
    }));

    assert.equal(decision.commitAllowed, true);
    assert.equal(decision.refreshPersistence?.durabilityReceipt.cas.scope, "scheduler-ledger");
    assert.equal(decision.refreshPersistence?.durabilityReceipt.ledger.revision, 8);
    assert.deepEqual(backend.ensureRequests[0]?.schedulerLedgerCas, schedulerLedgerCas);
    assert.deepEqual(backend.readBackRequests[0]?.schedulerLedgerCas, schedulerLedgerCas);

    const mismatchedReadBackBackend = new FixtureBackend({
        reread: currentReread("revision-2"),
        order: "advanced",
        readBackReceiptMutator: receipt => ({
            ...receipt,
            cas: { ...receipt.cas, commitId: "different-commit" },
        }),
    });
    const mismatchedReadBack = await new RecordSourceRefreshCoordinator(mismatchedReadBackBackend).coordinate(coordinateInput("task-scheduler-cas-mismatch", {
        schedulerLedgerCas,
    }));
    assert.equal(mismatchedReadBack.commitAllowed, false);
    assert.equal(mismatchedReadBack.reason, "pending-refresh-readback-unverified");
    assert.equal(mismatchedReadBack.conversationState.pendingRefreshKey, null);
    await assertConversationStateProjectionSatisfiesInvariant(mismatchedReadBack, "scheduler-cas-readback-mismatch");
}

async function testSeparateProcessesAndHardExit(): Promise<void> {
    const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "record-source-refresh-process-"));
    try {
        const runnerPath = path.join(temporaryRoot, "refresh-worker.mjs");
        fs.writeFileSync(runnerPath, buildProcessWorker(), "utf8");

        const concurrentRoot = path.join(temporaryRoot, "concurrent");
        fs.mkdirSync(concurrentRoot);
        const concurrent = await Promise.all([
            runProcessWorker(runnerPath, concurrentRoot, "task-process-a", "normal"),
            runProcessWorker(runnerPath, concurrentRoot, "task-process-b", "normal"),
        ]);
        const concurrentState = JSON.parse(fs.readFileSync(path.join(concurrentRoot, "refreshes.json"), "utf8")) as { refreshes: Record<string, StoredRefresh> };
        assert.equal(Object.keys(concurrentState.refreshes).length, 1);
        assert.equal(concurrent[0].code, 0);
        assert.equal(concurrent[1].code, 0);
        const firstOutput = parseWorkerOutput(concurrent[0]);
        const secondOutput = parseWorkerOutput(concurrent[1]);
        assert.equal(firstOutput.commitAllowed, true, firstOutput.reason);
        assert.equal(secondOutput.commitAllowed, true, secondOutput.reason);

        const crashRoot = path.join(temporaryRoot, "hard-exit");
        fs.mkdirSync(crashRoot);
        const hardExit = await runProcessWorker(runnerPath, crashRoot, "task-hard-exit", "hard-exit");
        assert.equal(hardExit.code, 73);
        const retry = await runProcessWorker(runnerPath, crashRoot, "task-hard-exit-retry", "normal");
        assert.equal(retry.code, 0);
        const retryOutput = parseWorkerOutput(retry);
        assert.equal(retryOutput.commitAllowed, true, retryOutput.reason);
        const retryState = JSON.parse(fs.readFileSync(path.join(crashRoot, "refreshes.json"), "utf8")) as { refreshes: Record<string, StoredRefresh> };
        assert.equal(Object.keys(retryState.refreshes).length, 1);
    } finally {
        fs.rmSync(temporaryRoot, { recursive: true, force: true });
    }
}

function buildProcessWorker(): string {
    const sourcePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/record-source-refresh.ts");
    const sourceUrl = pathToFileURL(sourcePath).href;
    return `
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { RecordSourceRefreshCoordinator, createPendingRefreshRecordHash } from ${JSON.stringify(sourceUrl)};

const root = process.argv[2];
const taskId = process.argv[3];
const mode = process.argv[4];
const identity = { chain: "codex", workspaceHash: "workspace-hash", conversationId: "conversation-id" };
const hash = value => "sha256:" + createHash("sha256").update(value).digest("hex");
const persistenceRoot = { dataRootId: "process-root", rootPathHash: hash(path.resolve(root)) };
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const snapshot = {
  schemaVersion: 5,
  sourceSnapshotId: "source-revision-1",
  snapshotRevision: 1,
  snapshotHash: "snapshot-hash-revision-1",
  snapshotRef: { path: "fake-root/snapshots/revision-1.json", hash: "snapshot-hash-revision-1", byteLength: 64 },
  conversationId: identity.conversationId,
  chain: identity.chain,
  workspaceHash: identity.workspaceHash,
  sourceRevision: "revision-1",
  desiredRevision: "revision-1",
  contentHash: "content-hash-revision-1",
  contentRef: { path: "fake-root/spool/revision-1.json", hash: "content-hash-revision-1", byteLength: 64 },
  formatterVersion: "formatter-1",
  readRange: { startRound: 1, endRound: 4, totalRounds: 4 },
  complete: true,
  gaps: [],
  parseWarnings: [],
};

function durableWriteJson(filePath, value) {
  const temporaryPath = filePath + ".tmp-" + process.pid;
  const descriptor = fs.openSync(temporaryPath, "w");
  try {
    fs.writeFileSync(descriptor, JSON.stringify(value), "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
  const targetDescriptor = fs.openSync(filePath, "r+");
  try { fs.fsyncSync(targetDescriptor); } finally { fs.closeSync(targetDescriptor); }
}

async function withLock(callback) {
  const lockPath = path.join(root, "refresh-lock");
  while (true) {
    try { fs.mkdirSync(lockPath); break; }
    catch (error) { if (error && error.code === "EEXIST") await wait(5); else throw error; }
  }
  try { return await callback(); }
  finally { fs.rmdirSync(lockPath); }
}

const statePath = path.join(root, "refreshes.json");
const backend = {
  async rereadCurrentSource() {
    return {
      kind: "current",
      identity,
      currentRevision: "revision-2",
      contentHash: "content-hash-revision-2",
      contentEvidence: { authority: "independent-content-hash", verified: true },
      complete: true,
      partial: false,
      cacheBypassed: true,
      errors: [],
    };
  },
  async compareAuthoritativeRevisions() { return "advanced"; },
  async ensurePendingRefresh(input) {
    const stored = await withLock(async () => {
      const state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : { refreshes: {} };
      if (state.refreshes[input.refreshKey]) return state.refreshes[input.refreshKey];
      await wait(25);
      const ledgerRef = { path: path.join(root, "ledger.json"), hash: "process-ledger-hash", byteLength: 256 };
      const pendingRefresh = {
        refreshKey: input.refreshKey,
        refreshTaskId: "process-refresh-task",
        sourceSnapshotId: input.sourceSnapshot.sourceSnapshotId,
        recordWorkKey: input.recordWorkKey,
        chain: input.identity.chain,
        workspaceHash: input.identity.workspaceHash,
        conversationId: input.identity.conversationId,
        fromRevision: input.fromRevision,
        desiredRevision: input.desiredRevision,
        persistedAt: "2026-07-14T00:00:00.000Z",
        ledgerRevision: 1,
        ledgerRef,
        state: "Queued",
      };
      const durabilityReceipt = {
        version: 1,
        refreshKey: input.refreshKey,
        rootBinding: input.persistenceRoot,
        ledger: { revision: 1, ref: ledgerRef, persistedHash: ledgerRef.hash },
        refreshRecordHash: createPendingRefreshRecordHash(pendingRefresh),
        durability: {
          scope: "process-crash-hot-restart",
          temporaryFileSynced: true,
          atomicReplaceCompleted: true,
          targetFileSynced: true,
          parentDirectory: { method: "windows-target-file-flush", durableBarrierCompleted: true },
        },
        cas: { scope: "refresh-ledger", ledgerId: "process-refresh-ledger", expectedRevision: 0, committedRevision: 1, transactionId: "process-cas" },
      };
      const created = { pendingRefresh, durabilityReceipt };
      state.refreshes[input.refreshKey] = created;
      durableWriteJson(statePath, state);
      return created;
    });
    if (mode === "hard-exit") process.exit(73);
    return { disposition: "attached", pendingRefresh: stored.pendingRefresh, durabilityReceipt: stored.durabilityReceipt };
  },
  async readBackPendingRefresh(input) {
    if (!fs.existsSync(statePath)) return { kind: "missing", reason: "state-missing" };
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    const stored = state.refreshes[input.refreshKey];
    if (!stored) return { kind: "missing", reason: "refresh-missing" };
    return {
      kind: "verified",
      readFrom: "durable-storage",
      refreshKey: input.refreshKey,
      rootBinding: stored.durabilityReceipt.rootBinding,
      pendingRefresh: stored.pendingRefresh,
      durabilityReceipt: stored.durabilityReceipt,
      ledger: stored.durabilityReceipt.ledger,
      refreshRecordHash: createPendingRefreshRecordHash(stored.pendingRefresh),
      observedAt: "2026-07-14T00:00:01.000Z",
    };
  },
};

const decision = await new RecordSourceRefreshCoordinator(backend).coordinate({
  taskId,
  recordWorkKey: "work-revision-1",
  sourceSnapshot: snapshot,
  persistenceRoot,
});
console.log(JSON.stringify({ commitAllowed: decision.commitAllowed, reason: decision.reason, refreshKey: decision.ledgerCommit && decision.ledgerCommit.pendingRefresh && decision.ledgerCommit.pendingRefresh.refreshKey }));
`;
}

interface ProcessWorkerResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

async function runProcessWorker(runnerPath: string, root: string, taskId: string, mode: "normal" | "hard-exit"): Promise<ProcessWorkerResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", runnerPath, root, taskId, mode], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", reject);
        child.on("close", code => resolve({ code, stdout, stderr }));
    });
}

function parseWorkerOutput(result: ProcessWorkerResult): { commitAllowed: boolean; reason: string; refreshKey: string } {
    if (result.code !== 0) throw new Error(`worker failed with ${result.code}: ${result.stderr}`);
    return JSON.parse(result.stdout.trim()) as { commitAllowed: boolean; reason: string; refreshKey: string };
}

function testHash(value: string): string {
    return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function clone<T>(value: T): T {
    return structuredClone(value);
}

async function run(): Promise<void> {
    await testExactlyEqualRevisionCoversCurrent();
    await testIncrementalSnapshotCoversCurrentWhenRevisionMatches();
    await testEqualRevisionDifferentHashFailsClosed();
    await testContentAddressedAuthorityMustValidateBinding();
    await testAdvancedRevisionRequiresDurableReadBack();
    await testRevisionSequencesAreForwardedToAuthoritativeComparator();
    await testVolatileBackendSuccessFailsClosed();
    await testForgedDurabilityReceiptsFailClosed();
    await testDeletedAndCorruptReadBackFailClosed();
    await testFailClosedSourceStatesAndOrdering();
    await testConcurrentAttachAndVerifyOneRefresh();
    await testCrashRetryAndDifferentRevisions();
    await testGenerationAppendCannotLoseRefresh();
    await testSchedulerLedgerCasBarrierIsBindable();
    await testSeparateProcessesAndHardExit();
    console.log("record-source-refresh tests passed");
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
