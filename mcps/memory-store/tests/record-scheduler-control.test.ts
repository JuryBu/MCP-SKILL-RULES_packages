import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-scheduler-control-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const contracts = await import("../src/record-scheduler-contracts.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");
const schedulerSpool = await import("../src/record-scheduler-spool.ts");
const workRegistry = await import("../src/record-work-registry.ts");
const schedulerControl = await import("../src/record-scheduler-control.ts");
const { startBackgroundTask, waitForBackgroundTask } = await import("../src/background-tasks.ts");

const seedSpool = schedulerSpool.createRecordSchedulerSpool({
    dataRoot,
    proofVerifier: {
        verifyTaskCancellation: async () => true,
        verifyBlobRelease: async () => true,
    },
});

type SeedOptions = {
    taskId: string;
    createdAt: string;
    workspaceHash?: string;
    running?: boolean;
    unitCount?: number;
    retainedDiscardedAttempt?: boolean;
};

type Seed = {
    taskId: string;
    identity: { chain: "codex"; workspaceHash: string; conversationId: string };
    location: { dataRoot: string; identity: { chain: "codex"; workspaceHash: string; conversationId: string } };
    sourceReference: { path: string; hash: string; byteLength: number };
    candidateReference: { path: string; hash: string; byteLength: number };
    sourceSnapshotReference: { path: string; hash: string; byteLength: number };
};

function sha256(value: string): string {
    return createHash("sha256").update(value).digest("hex");
}

function iso(offsetMs = 0): string {
    return new Date(Date.now() + offsetMs).toISOString();
}

function assertCreated<Value extends { kind: string }>(value: Value, expected: string, message?: string): asserts value is Value & { kind: typeof expected } {
    assert.equal(value.kind, expected, message);
}

async function initializeRegistry(location: Seed["location"], token: string) {
    const prepared = await workRegistry.initializeRecordWorkRegistryIdentity(location, { firstPublicationToken: token });
    assertCreated(prepared, "prepared");
    const created = await workRegistry.createRecordWorkRegistry(location, { firstPublicationToken: token });
    assertCreated(created, "created");
    return created;
}

async function bindAdmission(taskId: string, created: Awaited<ReturnType<typeof schedulerStore.createRecordSchedulerLedger>>) {
    const ledgerAnchor = schedulerStore.createSchedulerLedgerAnchor(created);
    const requestSummary = { source: "record-scheduler-control-test", taskId };
    const backgroundProjection = {};
    const capsule = await schedulerStore.writeRecordSchedulerAdmissionCapsule({
        schemaVersion: 2,
        kind: "record-scheduler-admission-capsule",
        taskId,
        taskKind: "record-batch-update",
        admissionIdentity: {
            requestKey: `record-scheduler-control:${taskId}`,
            requestHash: schedulerStore.calculateRecordSchedulerAdmissionRequestHash("record-batch-update", requestSummary, backgroundProjection),
        },
        ledgerAnchor,
        requestSummary,
        backgroundProjection,
    });
    return schedulerStore.bindRecordSchedulerAdmission(taskId, created.revision, ledgerAnchor, capsule.ref);
}

async function seedTask(options: SeedOptions): Promise<Seed> {
    const workspaceHash = options.workspaceHash || `workspace-${options.taskId}`;
    const unitCount = options.unitCount ?? 1;
    const identity = { chain: "codex" as const, workspaceHash, conversationId: `conversation-${options.taskId}` };
    const location = { dataRoot, identity };
    await seedSpool.initializeTask({ taskId: options.taskId, mode: "create" });
    const candidateSnapshot = await seedSpool.writeImmutable({ taskId: options.taskId, kind: "source", content: `candidate:${options.taskId}` });
    const sourceSnapshot = await seedSpool.writeImmutable({ taskId: options.taskId, kind: "source", content: `source-snapshot:${options.taskId}` });
    const source = await seedSpool.writeImmutable({ taskId: options.taskId, kind: "source", content: `source:${options.taskId}` });
    const registry = await initializeRegistry(location, `publication:${options.taskId}`);
    const attached = await workRegistry.startOrAttachRecordWork({
        ...location,
        desiredRevision: "source-revision-1",
        taskId: options.taskId,
        expectedRegistryRevision: registry.registry.registryRevision,
    });
    assertCreated(attached, "started");
    const leased = await workRegistry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: attached.work.recordWorkKey,
        taskId: options.taskId,
        ownerId: "initial-owner",
        schedulerEpoch: 1,
        expectedRegistryRevision: attached.registry.registryRevision,
        leaseDurationMs: 60 * 60_000,
    });
    assertCreated(leased, "acquired");
    const sourceHash = source.reference.hash;
    const running = options.running === true;
    const timestamp = options.createdAt;
    const admissionIdentity = {
        requestKey: `record-scheduler-control:${options.taskId}`,
        requestHash: schedulerStore.calculateRecordSchedulerAdmissionRequestHash(
            "record-batch-update",
            { source: "record-scheduler-control-test", taskId: options.taskId },
            {},
        ),
    };
    const attempt = [{
        attemptId: `${options.taskId}-attempt`,
        unitId: `${options.taskId}-unit-0`,
        recordWorkKey: attached.work.recordWorkKey,
        originTaskIds: [options.taskId],
        activeTaskIds: [options.taskId],
        state: "DispatchIntentPersisted" as const,
        provider: "grok" as const,
        model: "grok-4.5",
        dispatchIntentAt: timestamp,
        dispatchIntentLedgerRevision: 1,
        dispatchIntentRef: source.reference,
        inputHash: sha256(`input:${options.taskId}`),
        idempotencyKey: null,
        fence: { ...leased.fence },
    }];
    const initial = {
        schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger" as const,
        revision: 1,
        persistedHash: "placeholder",
        task: {
            taskId: options.taskId,
            schedulerEpoch: 1,
            state: "Running" as const,
            requestMode: "batch_update" as const,
            candidateSnapshotId: `${options.taskId}-candidate`,
            candidateSnapshotRevision: 1,
            admissionIdentity,
            admission: { state: "LedgerCreated" as const },
            createdAt: timestamp,
            updatedAt: timestamp,
            repairState: "None" as const,
            recordItems: { total: 1, succeeded: 0, failed: 0, unresolved: 0 },
            units: { materialized: unitCount, eligible: 0, running: unitCount, done: 0, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot: {
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            snapshotId: `${options.taskId}-candidate`,
            snapshotRevision: 1,
            snapshotHash: candidateSnapshot.reference.hash,
            snapshotRef: candidateSnapshot.reference,
            createdAt: timestamp,
            requestMode: "normal" as const,
            filters: {},
            enumerations: [{ chain: "codex" as const, complete: true, paginationExhausted: true, truncated: false }],
            candidates: [{
                conversationId: identity.conversationId,
                chain: "codex" as const,
                workspaceHash,
                state: "Missing" as const,
                evidence: ["exact-read"],
                evidenceHash: sha256(`candidate-evidence:${options.taskId}`),
            }],
        },
        sourceSnapshots: [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            sourceSnapshotId: `${options.taskId}-source`,
            snapshotRevision: 1,
            snapshotHash: sourceSnapshot.reference.hash,
            snapshotRef: sourceSnapshot.reference,
            conversationId: identity.conversationId,
            chain: "codex" as const,
            workspaceHash,
            sourceRevision: "source-revision-1",
            desiredRevision: "source-revision-1",
            contentHash: sourceHash,
            contentRef: source.reference,
            formatterVersion: "test-v1",
            readRange: { startRound: 1, endRound: 1, totalRounds: 1 },
            complete: true,
            gaps: [],
            parseWarnings: [],
        }],
        recordWork: [{
            recordWorkKey: attached.work.recordWorkKey,
            conversationId: identity.conversationId,
            chain: "codex" as const,
            workspaceHash,
            desiredRevision: "source-revision-1",
            recordCommitEpoch: leased.work.recordCommitEpoch,
            registryRevision: leased.registry.registryRevision,
            registryRef: { path: `record-recovery/record-work/${options.taskId}.json`, hash: `${options.taskId}-registry`, byteLength: 64 },
            schedulerEpoch: leased.fence.schedulerEpoch,
            workLeaseId: leased.fence.workLeaseId,
            leaseOwnerId: "initial-owner",
            leaseExpiresAt: leased.lease.expiresAt,
            activeTaskIds: [options.taskId],
            currentFencingToken: leased.fence.fencingToken,
        }],
        units: Array.from({ length: unitCount }, (_, index) => ({
            unitId: `${options.taskId}-unit-${index}`,
            taskId: options.taskId,
            recordId: identity.conversationId,
            state: "Running" as const,
            layer: "record",
            splitDepth: 0,
            recordWorkKey: attached.work.recordWorkKey,
            recordCommitEpoch: leased.work.recordCommitEpoch,
            dependencies: [],
            composeOrder: index,
            sourceSnapshotId: `${options.taskId}-source`,
            inputHash: sha256(`input:${options.taskId}${index === 0 ? "" : `:${index}`}`),
            estimatedCost: 1,
            routePlan: ["grok" as const],
            attemptedProviders: ["grok" as const],
            retryBudget: 1,
            enqueueTime: timestamp,
            layerEnterTime: timestamp,
        })),
        attempts: attempt,
        commits: [],
    };
    const created = await schedulerStore.createRecordSchedulerLedger(initial);
    const bound = await bindAdmission(options.taskId, created);
    if (!running) {
        await schedulerStore.mutateRecordSchedulerLedger(options.taskId, bound.revision, ledger => {
            ledger.task.state = "Queued";
            for (const unit of ledger.units) unit.state = "Queued";
            if (options.retainedDiscardedAttempt) {
                ledger.attempts[0]!.state = "Discarded";
                ledger.attempts[0]!.outcome = "discarded";
                ledger.attempts[0]!.activeTaskIds = [];
            } else {
                ledger.attempts = [];
            }
            ledger.task.units = { materialized: unitCount, eligible: unitCount, running: 0, done: 0, failed: 0 };
        });
    } else {
        const current = await currentLedger(options.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(options.taskId, current.revision, ledger => {
            ledger.attempts[0]!.state = "Dispatched";
            ledger.attempts[0]!.outcome = "dispatched";
            ledger.attempts[0]!.startedAt = timestamp;
            ledger.attempts[0]!.leaseExpiresAt = leased.lease.expiresAt;
        });
    }
    return {
        taskId: options.taskId,
        identity,
        location,
        sourceReference: source.reference,
        candidateReference: candidateSnapshot.reference,
        sourceSnapshotReference: sourceSnapshot.reference,
    };
}

async function currentLedger(taskId: string) {
    const read = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
    assertCreated(read, "current");
    return read.ledger;
}

async function markTaskSucceeded(taskId: string, updatedAt: string): Promise<void> {
    const current = await currentLedger(taskId);
    await schedulerStore.mutateRecordSchedulerLedger(taskId, current.revision, ledger => {
        ledger.task.state = "Succeeded";
        ledger.task.terminalState = "Succeeded";
        ledger.task.updatedAt = updatedAt;
        ledger.task.recordItems = { ...ledger.task.recordItems, succeeded: ledger.task.recordItems.total, failed: 0, unresolved: 0 };
        for (const unit of ledger.units) unit.state = "Succeeded";
        ledger.task.units = { materialized: ledger.units.length, eligible: 0, running: 0, done: ledger.units.length, failed: 0 };
    });
}

async function run(name: string, action: () => Promise<void>): Promise<void> {
    await action();
    console.log(`ok - ${name}`);
}

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => {
        resolve = done;
    });
    return { promise, resolve };
}

try {
    await seedSpool.initializeRoot({ mode: "create" });
    const base = Date.parse("2026-07-13T12:00:00.000Z");
    const first = await seedTask({ taskId: "workspace-a", createdAt: new Date(base).toISOString(), workspaceHash: "workspace-a" });
    await seedTask({ taskId: "workspace-b", createdAt: new Date(base + 1).toISOString(), workspaceHash: "workspace-b" });
    await seedTask({ taskId: "workspace-c", createdAt: new Date(base + 2).toISOString(), workspaceHash: "workspace-c" });
    const control = schedulerControl.createRecordSchedulerControl({ dataRoot });

    await run("6 Unit 前 Task 仅在权威终态后减少 aheadTaskCount，跨 workspace/owner 与同毫秒排序稳定", async () => {
        const displayBase = base - 10_000;
        const first = await seedTask({
            taskId: "display-a-six-units",
            createdAt: new Date(displayBase).toISOString(),
            workspaceHash: "workspace-owner-a",
            running: true,
            unitCount: 6,
        });
        const second = await seedTask({
            taskId: "display-b-one-unit",
            createdAt: new Date(displayBase + 1).toISOString(),
            workspaceHash: "workspace-owner-b",
            running: true,
        });
        const nonRecord = startBackgroundTask("non-record-control-test", async () => "excluded from record scheduler namespace");
        assert.equal((await waitForBackgroundTask(nonRecord.id, 1))?.status, "done");
        assert.equal(control.status(second.taskId).aheadTaskCount, 1);

        const partial = await currentLedger(first.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(first.taskId, partial.revision, ledger => {
            for (const unit of ledger.units.slice(0, 5)) unit.state = "Succeeded";
            ledger.task.updatedAt = new Date(displayBase + 2).toISOString();
            ledger.task.units = { materialized: 6, eligible: 0, running: 1, done: 5, failed: 0 };
        });
        const firstAfterFiveOfSix = control.status(first.taskId);
        assert.equal(firstAfterFiveOfSix.units?.materialized, 6);
        assert.equal(firstAfterFiveOfSix.units?.done, 5);
        assert.equal(firstAfterFiveOfSix.taskState, "Running");
        const afterFiveOfSix = control.status(second.taskId);
        assert.equal(afterFiveOfSix.units?.materialized, 1);
        assert.equal(afterFiveOfSix.aheadTaskCount, 1);

        const allUnitsDone = await currentLedger(first.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(first.taskId, allUnitsDone.revision, ledger => {
            for (const unit of ledger.units) unit.state = "Succeeded";
            ledger.task.updatedAt = new Date(displayBase + 3).toISOString();
            ledger.task.units = { materialized: 6, eligible: 0, running: 0, done: 6, failed: 0 };
        });
        const firstAfterAllUnitsDone = control.status(first.taskId);
        assert.equal(firstAfterAllUnitsDone.units?.materialized, 6);
        assert.equal(firstAfterAllUnitsDone.units?.done, 6);
        assert.equal(firstAfterAllUnitsDone.taskState, "Running");
        assert.equal(control.status(second.taskId).aheadTaskCount, 1);

        await markTaskSucceeded(first.taskId, new Date(displayBase + 4).toISOString());
        assert.equal(control.status(first.taskId).taskState, "Succeeded");
        assert.equal(control.status(second.taskId).aheadTaskCount, 0);
        await markTaskSucceeded(second.taskId, new Date(displayBase + 5).toISOString());

        const tieCreatedAt = new Date(displayBase + 6).toISOString();
        const tieFirst = await seedTask({ taskId: "display-tie-a", createdAt: tieCreatedAt, workspaceHash: "workspace-tie-a", running: true });
        const tieSecond = await seedTask({ taskId: "display-tie-b", createdAt: tieCreatedAt, workspaceHash: "workspace-tie-b", running: true });
        assert.equal(control.status(tieFirst.taskId).aheadTaskCount, 0);
        assert.equal(control.status(tieSecond.taskId).aheadTaskCount, 1);
        await markTaskSucceeded(tieFirst.taskId, new Date(displayBase + 7).toISOString());
        await markTaskSucceeded(tieSecond.taskId, new Date(displayBase + 8).toISOString());
    });

    await run("跨 workspace/owner 的 aheadTaskCount 使用完整 ledger namespace", async () => {
        const status = control.status("workspace-c");
        assert.equal(status.aheadTaskCount, 2);
        assert.equal(status.namespaceRepair, false);
        assert.equal(status.taskState, "Queued");
    });

    await run("坏 ledger 进入 RepairRequired 且 namespace 不伪造精确 ahead", async () => {
        const brokenPath = schedulerStore.recordSchedulerLedgerPath("broken-ledger");
        await fs.mkdir(path.dirname(brokenPath), { recursive: true });
        await fs.writeFile(brokenPath, "{not-json", "utf8");
        const status = control.status("workspace-c");
        assert.equal(status.aheadTaskCount, null);
        assert.equal(status.namespaceRepair, true);
        assert.equal(control.status("broken-ledger").state, "RepairRequired");
        await fs.rm(brokenPath, { force: true });
    });

    await run("queued cancel 的状态序列、CAS 幂等与 immutable anchor", async () => {
        await seedTask({ taskId: "queued-cancel", createdAt: iso(), workspaceHash: "queue" });
        const before = control.status("queued-cancel");
        assert.equal(before.taskState, "Queued");
        const cancelled = await control.cancel("queued-cancel");
        assert.equal(cancelled.disposition, "cancelled", cancelled.reason);
        assert.equal(cancelled.status.taskState, "Cancelled");
        assert.ok(cancelled.evidence);
        const repeated = await control.cancel("queued-cancel");
        assert.equal(repeated.disposition, "already_cancelled");
        assert.equal(cancelled.evidence?.ledgerAnchor.ledgerRevision, 1);
        const ledger = await currentLedger("queued-cancel");
        assert.equal(ledger.units[0]?.state, "Cancelled");
    });

    await run("Deferred 等权威终态 cancel 只读返回且 ledger/spool 不变", async () => {
        for (const state of ["Succeeded", "Deferred", "FailedFinal", "RepairRequired"] as const) {
            const taskId = `terminal-cancel-${state.toLowerCase()}`;
            const seed = await seedTask({ taskId, createdAt: iso(), workspaceHash: `terminal-${state}` });
            const current = await currentLedger(taskId);
            await schedulerStore.mutateRecordSchedulerLedger(taskId, current.revision, ledger => {
                ledger.task.state = state;
                ledger.task.terminalState = state;
                ledger.task.repairState = state === "RepairRequired" ? "Required" : "None";
                if (state === "Deferred") {
                    ledger.task.sourceResolution = {
                        phase: "deferred",
                        selectedCount: null,
                        materializedCount: 0,
                        unresolvedCount: 1,
                        deferredReason: "source_unresolved",
                        issues: [{
                            host: "codex",
                            code: "source-list-incomplete",
                            message: "source list unavailable",
                            evidenceHashes: [ledger.candidateSnapshot.snapshotHash],
                        }],
                    };
                }
            });
            const before = await currentLedger(taskId);
            const result = await control.cancel(taskId);
            assert.equal(result.disposition, "already_terminal");
            assert.equal(result.status.taskState, state);
            const after = await currentLedger(taskId);
            assert.equal(after.revision, before.revision);
            assert.equal(after.persistedHash, before.persistedHash);
            assert.equal((await seedSpool.readImmutable({ taskId, kind: "source", reference: seed.sourceReference })).toString("utf8"), `source:${taskId}`);
            if (state === "Deferred") {
                assert.match(result.status.reason || "", /来源证据不足/u);
                assert.equal(result.status.sourceResolution?.deferredReason, "source_unresolved");
            }
        }
    });

    await run("cancel 初读后终态抢占不产生空写或清理副作用", async () => {
        const taskId = "terminal-cancel-race";
        const seed = await seedTask({ taskId, createdAt: iso(), workspaceHash: "terminal-cancel-race" });
        let terminalRevision = 0;
        let terminalHash = "";
        let injectionCount = 0;
        const racingControl = schedulerControl.createRecordSchedulerControl({
            dataRoot,
            faultInjector: async event => {
                if (event.point !== "before-cancellation-request" || event.taskId !== taskId || injectionCount > 0) return;
                injectionCount += 1;
                const current = await currentLedger(taskId);
                const terminal = await schedulerStore.mutateRecordSchedulerLedger(taskId, current.revision, ledger => {
                    ledger.task.state = "Deferred";
                    ledger.task.terminalState = "Deferred";
                    ledger.task.sourceResolution = {
                        phase: "deferred",
                        selectedCount: 1,
                        materializedCount: 0,
                        unresolvedCount: 1,
                        deferredReason: "source_unresolved",
                        issues: [{
                            host: "codex",
                            conversationId: seed.identity.conversationId,
                            code: "exact-fetch-unresolved",
                            message: "terminal race fixture",
                            evidenceHashes: [ledger.candidateSnapshot.snapshotHash],
                        }],
                    };
                    ledger.task.recordItems.unresolved = 1;
                });
                terminalRevision = terminal.revision;
                terminalHash = terminal.hash;
            },
        });

        const result = await racingControl.cancel(taskId);
        assert.equal(result.disposition, "already_terminal");
        assert.equal(result.status.taskState, "Deferred");
        assert.equal(injectionCount, 1);
        const after = await currentLedger(taskId);
        assert.equal(after.revision, terminalRevision, "终态抢占后 cancel 不得再做 no-op revision 写入");
        assert.equal(after.persistedHash, terminalHash, "终态抢占后 ledger hash 必须保持抢占值");
        assert.equal(after.task.state, "Deferred");
        const registry = await workRegistry.readRecordWorkRegistry(seed.location);
        assertCreated(registry, "ready");
        assert.ok(registry.registry.works[0]?.activeTaskIds.includes(taskId), "终态抢占后不得 detach record work");
        assert.equal(
            (await seedSpool.readImmutable({ taskId, kind: "source", reference: seed.sourceReference })).toString("utf8"),
            `source:${taskId}`,
            "终态抢占后不得清理 spool",
        );
    });

    await run("running cancel 重启可重入、迟到结果只会 Discarded", async () => {
        const running = await seedTask({ taskId: "running-cancel", createdAt: iso(), workspaceHash: "running", running: true });
        const firstCancel = await control.cancel(running.taskId);
        assert.equal(firstCancel.disposition, "cancelling");
        assert.equal(firstCancel.status.taskState, "Cancelling");
        assert.ok(firstCancel.evidence);
        assert.equal(await schedulerControl.verifyLedgerBackedTaskCancellationProof(firstCancel.evidence!.ledgerAnchor), true);
        assert.equal(await schedulerControl.verifyLedgerBackedTaskCancellationProof({
            ...firstCancel.evidence!.ledgerAnchor,
            ledgerHash: "0".repeat(64),
        }), false);
        await assert.rejects(
            () => control.spool.cancelTask({
                taskId: running.taskId,
                cancellationProof: { ...firstCancel.evidence!.ledgerAnchor, ledgerHash: "0".repeat(64) },
                releaseProofs: [],
            }),
            /proof|rejected/u,
        );
        const restarted = schedulerControl.createRecordSchedulerControl({ dataRoot });
        assert.equal((await restarted.cancel(running.taskId)).disposition, "cancelling");
        await restarted.spool.initializeRoot({ mode: "open" });
        await restarted.spool.initializeTask({ taskId: running.taskId, mode: "open" });
        const output = await restarted.spool.writeImmutable({ taskId: running.taskId, kind: "output", content: "late-result" });
        await restarted.discardLateAttempt({ taskId: running.taskId, attemptId: "running-cancel-attempt", outputRef: output.reference });
        assert.equal((await restarted.cancel(running.taskId)).disposition, "cancelled");
        const ledger = await currentLedger(running.taskId);
        assert.equal(ledger.attempts[0]?.state, "Discarded");
        assert.equal(ledger.units[0]?.state, "Discarded");
    });

    await run("共享 work 的取消只 detach 当前 task，较高 epoch 不会被补偿", async () => {
        const shared = await seedTask({ taskId: "shared-a", createdAt: iso(), workspaceHash: "shared" });
        const registryBefore = await workRegistry.readRecordWorkRegistry(shared.location);
        assertCreated(registryBefore, "ready");
        const attached = await workRegistry.startOrAttachRecordWork({
            ...shared.location,
            desiredRevision: "source-revision-1",
            taskId: "shared-b",
            expectedRegistryRevision: registryBefore.registry.registryRevision,
        });
        assertCreated(attached, "started");
        const leased = await workRegistry.acquireRecordWorkLease({
            ...shared.location,
            recordWorkKey: attached.work.recordWorkKey,
            taskId: "shared-b",
            ownerId: "owner-b",
            schedulerEpoch: 9,
            expectedRegistryRevision: attached.registry.registryRevision,
            nowMs: Date.now() + 2 * 60 * 60_000,
        });
        assertCreated(leased, "acquired");
        assert.equal((await control.cancel(shared.taskId)).disposition, "cancelled");
        const registryAfter = await workRegistry.readRecordWorkRegistry(shared.location);
        assertCreated(registryAfter, "ready");
        const work = registryAfter.registry.works.find(candidate => candidate.recordWorkKey === attached.work.recordWorkKey);
        assert.deepEqual(work?.activeTaskIds, ["shared-b"]);
        assert.equal(work?.ownerLease?.schedulerEpoch, 9);
    });

    await run("owner recovery 在 registry/spool 回读前保持 barrier，旧 owner 被 fencing", async () => {
        const recovery = await seedTask({ taskId: "owner-recovery", createdAt: iso(), workspaceHash: "owner" });
        const firstRecovery = await control.recoverOwner({
            taskId: recovery.taskId,
            ownerId: "owner-a",
            leaseMs: 1_000,
            workLeaseMs: 1_000,
        });
        assertCreated(firstRecovery, "recovered", "reason" in firstRecovery ? firstRecovery.reason : undefined);
        assert.equal(firstRecovery.status.taskState, "Queued");
        const secondRecovery = await control.recoverOwner({
            taskId: recovery.taskId,
            ownerId: "owner-b",
            nowMs: Date.now() + 2_000,
            leaseMs: 1_000,
            workLeaseMs: 1_000,
        });
        assertCreated(secondRecovery, "recovered");
        const current = await currentLedger(recovery.taskId);
        await assert.rejects(
            () => schedulerStore.mutateRecordSchedulerLedgerAsOwner(
                recovery.taskId,
                current.revision,
                firstRecovery.ownerLease,
                ledger => { ledger.task.updatedAt = iso(); },
                { nowMs: Date.now() + 2_000 },
            ),
            /fencing|owner/u,
        );
    });

    await run("owner 接管会以新 registry lease 重绑活跃 Attempt、CleanupPending Commit 与嵌套 fence", async () => {
        const recovery = await seedTask({
            taskId: "owner-recovery-all-fences",
            createdAt: iso(),
            workspaceHash: "owner-recovery-all-fences",
            running: true,
        });
        const commitContent = await seedSpool.writeImmutable({
            taskId: recovery.taskId,
            kind: "output",
            content: "commit content written to the real task spool",
        });
        const admissionCapsule = await schedulerStore.readRecordSchedulerAdmissionCapsule(recovery.taskId);
        assertCreated(admissionCapsule, "current");
        const spoolCapsule = await seedSpool.writeImmutable({
            taskId: recovery.taskId,
            kind: "source",
            content: JSON.stringify(admissionCapsule.capsule),
        });
        const beforeImageContent = await seedSpool.writeImmutable({
            taskId: recovery.taskId,
            kind: "source",
            content: "body before image written to the real task spool",
        });
        for (const { kind, reference } of [
            { kind: "source" as const, reference: recovery.candidateReference },
            { kind: "source" as const, reference: recovery.sourceSnapshotReference },
            { kind: "source" as const, reference: spoolCapsule.reference },
            { kind: "output" as const, reference: commitContent.reference },
        ]) {
            const content = await seedSpool.readImmutable({
                taskId: recovery.taskId,
                kind,
                reference,
            });
            assert.ok(content.byteLength > 0, "candidate/source/capsule/content 必须来自可回读的 task spool");
        }

        const prepared = await currentLedger(recovery.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(recovery.taskId, prepared.revision, ledger => {
            const attempt = ledger.attempts[0]!;
            const unit = ledger.units[0]!;
            const work = ledger.recordWork[0]!;
            const fence = {
                schedulerEpoch: work.schedulerEpoch,
                recordCommitEpoch: work.recordCommitEpoch,
                fencingToken: work.currentFencingToken,
                workLeaseId: work.workLeaseId,
            };
            const commitId = `${recovery.taskId}-commit`;
            const beforeImage = {
                commitId,
                capturedAt: iso(),
                body: {
                    path: "records/body.md",
                    existed: true,
                    revision: "body-before-revision",
                    hash: beforeImageContent.reference.hash,
                    contentRef: beforeImageContent.reference,
                },
                mainIndexEntry: { path: "records/main-index.json", existed: false },
                readerIndexEntry: { path: "records/reader-index.json", existed: false },
                fence,
            };
            attempt.state = "KnownSuccess";
            attempt.outcome = "known_success";
            attempt.outputRef = commitContent.reference;
            unit.state = "Committing";
            unit.resultRef = commitContent.reference;
            unit.commitId = commitId;
            ledger.commits.push({
                schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
                commitId,
                taskId: recovery.taskId,
                unitId: unit.unitId,
                attemptId: attempt.attemptId,
                recordWorkKey: work.recordWorkKey,
                sourceSnapshotId: unit.sourceSnapshotId,
                inputHash: unit.inputHash,
                outputHash: commitContent.reference.hash,
                qualityResult: { accepted: true },
                bodyRef: commitContent.reference,
                bodyHash: commitContent.reference.hash,
                ownership: { mode: "task_exclusive", ownerTaskId: recovery.taskId },
                beforeImage,
                observedSourceRevisionAtCommit: "source-revision-1",
                state: "CleanupPending",
                cleanupPhase: "Compensating",
                cleanupReadBack: {
                    commitId,
                    taskId: recovery.taskId,
                    recordWorkKey: work.recordWorkKey,
                    verifiedAt: iso(),
                    registryRevision: work.registryRevision,
                    body: {
                        path: beforeImage.body.path,
                        taskCommitVisible: false,
                        disposition: "restored_before_image",
                        observedHash: beforeImage.body.hash,
                        observedRevision: beforeImage.body.revision,
                    },
                    mainIndexEntry: { path: beforeImage.mainIndexEntry.path, taskCommitVisible: false, disposition: "absent" },
                    readerIndexEntry: { path: beforeImage.readerIndexEntry.path, taskCommitVisible: false, disposition: "absent" },
                    fence,
                },
                successConditions: {
                    candidateSnapshotFrozen: false,
                    sourceSnapshotPersisted: false,
                    modelOutputBoundAndQualified: false,
                    bodyAtomicallyWritten: false,
                    mainIndexPublished: false,
                    readerIndexConsistent: false,
                    ledgerConsistent: false,
                    readBackVerified: false,
                },
                fence,
            });
        });

        const recoveryNow = Date.now();
        const ownerA = await control.recoverOwner({
            taskId: recovery.taskId,
            ownerId: "owner-a",
            nowMs: recoveryNow,
            leaseMs: 1_000,
            workLeaseMs: 1_000,
        });
        assertCreated(ownerA, "recovered");
        const ownerBNow = recoveryNow + 2_000;
        const ownerB = await control.recoverOwner({
            taskId: recovery.taskId,
            ownerId: "owner-b",
            nowMs: ownerBNow,
            leaseMs: 1_000,
            workLeaseMs: 1_000,
        });
        assertCreated(ownerB, "recovered");

        const registry = await workRegistry.readRecordWorkRegistry(recovery.location);
        assertCreated(registry, "ready");
        const registryWork = registry.registry.works[0]!;
        assert.equal(registryWork.ownerLease?.ownerId, "owner-b");
        const expectedFence = {
            schedulerEpoch: registryWork.ownerLease!.schedulerEpoch,
            recordCommitEpoch: registryWork.recordCommitEpoch,
            fencingToken: registryWork.currentFencingToken,
            workLeaseId: registryWork.ownerLease!.workLeaseId,
        };
        const stored = await schedulerStore.readRecordSchedulerLedgerStore(recovery.taskId, { expectPublished: true });
        assertCreated(stored, "current", "接管后账本不得退化为 invalid_current_ledger");
        const current = stored.ledger;
        const commit = current.commits[0]!;
        assert.deepEqual({
            schedulerEpoch: current.recordWork[0]!.schedulerEpoch,
            recordCommitEpoch: current.recordWork[0]!.recordCommitEpoch,
            fencingToken: current.recordWork[0]!.currentFencingToken,
            workLeaseId: current.recordWork[0]!.workLeaseId,
        }, expectedFence, "work fence 必须匹配新 registry lease");
        assert.deepEqual(current.attempts[0]!.fence, expectedFence, "active Attempt fence 必须匹配新 registry lease");
        assert.deepEqual(commit.fence, expectedFence, "Commit fence 必须匹配新 registry lease");
        assert.deepEqual(commit.beforeImage?.fence, expectedFence, "beforeImage fence 必须匹配新 registry lease");
        assert.deepEqual(commit.cleanupReadBack?.fence, expectedFence, "cleanupReadBack fence 必须匹配新 registry lease");

        await assert.rejects(
            () => schedulerStore.mutateRecordSchedulerLedgerAsOwner(
                recovery.taskId,
                current.revision,
                ownerA.ownerLease,
                ledger => { ledger.task.updatedAt = new Date(ownerBNow).toISOString(); },
                { nowMs: ownerBNow },
            ),
            /fencing|owner/u,
            "旧 owner 的普通写入必须被拒绝",
        );
        let staleCommitMutationRan = false;
        await assert.rejects(
            () => schedulerStore.mutateRecordSchedulerLedgerAsOwner(
                recovery.taskId,
                current.revision,
                ownerA.ownerLease,
                ledger => {
                    staleCommitMutationRan = true;
                    ledger.commits[0]!.cleanupPhase = "Verified";
                },
                { nowMs: ownerBNow },
            ),
            /fencing|owner/u,
            "旧 owner 的 Commit 写入必须被拒绝",
        );
        assert.equal(staleCommitMutationRan, false, "旧 owner 的 Commit mutation 不得进入回调");
        assertCreated(await schedulerStore.readRecordSchedulerLedgerStore(recovery.taskId, { expectPublished: true }), "current");
    });

    await run("已有 scheduler owner 时 cancel 与迟到结果带当前 lease 完成，不触发 unowned fence", async () => {
        const owned = await seedTask({
            taskId: "owner-cancel",
            createdAt: iso(),
            workspaceHash: "owner-cancel",
            retainedDiscardedAttempt: true,
        });
        const recovered = await control.recoverOwner({
            taskId: owned.taskId,
            ownerId: "owner-cancel-a",
            leaseMs: 60_000,
            workLeaseMs: 60_000,
        });
        assertCreated(recovered, "recovered", "reason" in recovered ? recovered.reason : undefined);
        const completed = await control.cancel(owned.taskId);
        assert.equal(completed.disposition, "cancelled", completed.reason);
        const discarded = await control.discardLateAttempt({
            taskId: owned.taskId,
            attemptId: "owner-cancel-attempt",
        });
        assert.equal(discarded.taskState, "Cancelled");
        assert.equal((await currentLedger(owned.taskId)).task.repairState, "None");
    });

    await run("缺失 immutable admission capsule 时 proof 与取消都 fail closed，spool 不会被 sealed", async () => {
        const missingCapsule = await seedTask({ taskId: "capsule-missing-cancel", createdAt: iso(), workspaceHash: "capsule-missing" });
        await fs.rm(schedulerStore.recordSchedulerAdmissionCapsulePath(missingCapsule.taskId), { force: true });
        const before = await currentLedger(missingCapsule.taskId);
        assert.equal(await schedulerControl.verifyLedgerBackedTaskCancellationProof(schedulerControl.cancellationEvidenceForLedger(before)!.ledgerAnchor), false);
        const cancelled = await control.cancel(missingCapsule.taskId);
        assert.equal(cancelled.disposition, "repair_required");
        assert.equal((await control.spool.readImmutable({
            taskId: missingCapsule.taskId,
            kind: "source",
            reference: missingCapsule.sourceReference,
        })).toString("utf8"), `source:${missingCapsule.taskId}`);
    });

    await run("UnknownOutcome 保持控制面可见且 cancel 不假装完成", async () => {
        const unknown = await seedTask({ taskId: "unknown-outcome", createdAt: iso(), workspaceHash: "unknown", running: true });
        const before = await currentLedger(unknown.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(unknown.taskId, before.revision, ledger => {
            const unknownOutcomeAt = iso();
            ledger.attempts[0]!.state = "UnknownOutcome";
            ledger.attempts[0]!.outcome = "unknown_outcome";
            ledger.attempts[0]!.unknownOutcomeAt = unknownOutcomeAt;
            ledger.attempts[0]!.unknownOutcomeUntil = new Date(Date.parse(unknownOutcomeAt) + 30_000).toISOString();
            ledger.attempts[0]!.unknownOutcomeGraceMs = 30_000;
            ledger.attempts[0]!.errorClass = "UnknownOutcome";
            ledger.attempts[0]!.providerEvidence = "provider acknowledgement unavailable";
            ledger.units[0]!.state = "UnknownOutcome";
            ledger.task.units.running = 0;
        });
        assert.equal(control.status(unknown.taskId).unknownOutcomeAttemptCount, 1);
        assert.equal((await control.cancel(unknown.taskId)).disposition, "cancelling");
    });

    await run("UnknownOutcome 超过 contracts grace 后按时钟结算，不会永久卡在 Cancelling", async () => {
        const expired = await seedTask({ taskId: "unknown-outcome-expired", createdAt: iso(-60_000), workspaceHash: "unknown-expired", running: true });
        const before = await currentLedger(expired.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(expired.taskId, before.revision, ledger => {
            const unknownOutcomeAt = iso(-30_001);
            ledger.attempts[0]!.state = "UnknownOutcome";
            ledger.attempts[0]!.outcome = "unknown_outcome";
            ledger.attempts[0]!.unknownOutcomeAt = unknownOutcomeAt;
            ledger.attempts[0]!.unknownOutcomeUntil = new Date(Date.parse(unknownOutcomeAt) + 30_000).toISOString();
            ledger.attempts[0]!.unknownOutcomeGraceMs = 30_000;
            ledger.attempts[0]!.errorClass = "UnknownOutcome";
            ledger.attempts[0]!.providerEvidence = "provider acknowledgement unavailable";
            ledger.units[0]!.state = "UnknownOutcome";
            ledger.task.units.running = 0;
        });
        const cancelled = await control.cancel(expired.taskId);
        assert.equal(cancelled.disposition, "cancelled", cancelled.reason);
        const after = await currentLedger(expired.taskId);
        assert.equal(after.task.state, "Cancelled");
        assert.equal(after.attempts[0]?.state, "UnknownOutcome");
        assert.equal(after.attempts[0]?.activeTaskIds.includes(expired.taskId), false);
    });

    await run("跨 dataRoot 的 control 不能用 A ledger 删除 B 的同 task/blob", async () => {
        const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "memory-store-scheduler-control-root-b-"));
        try {
            const taskId = "cross-root-control";
            await seedTask({ taskId, createdAt: iso(), workspaceHash: "cross-root-a" });
            const spoolB = schedulerSpool.createRecordSchedulerSpool({
                dataRoot: rootB,
                proofVerifier: {
                    verifyTaskCancellation: async () => true,
                    verifyBlobRelease: async () => true,
                },
            });
            await spoolB.initializeRoot({ mode: "create" });
            await spoolB.initializeTask({ taskId, mode: "create" });
            const blobB = await spoolB.writeImmutable({ taskId, kind: "source", content: "same task/blob under B" });
            const foreignControl = schedulerControl.createRecordSchedulerControl({ dataRoot: rootB });
            const result = await foreignControl.cancel(taskId);
            assert.equal(result.disposition, "repair_required");
            assert.match(result.reason || "", /root/u);
            assert.equal((await spoolB.readImmutable({ taskId, kind: "source", reference: blobB.reference })).toString("utf8"), "same task/blob under B");
        } finally {
            await fs.rm(rootB, { recursive: true, force: true });
        }
    });

    await run("30 路并发 cancel 多轮 CAS 冲突只收敛到取消结果，不伪报 repair", async () => {
        for (let round = 0; round < 3; round += 1) {
            const taskId = `concurrent-cancel-${round}`;
            await seedTask({ taskId, createdAt: iso(), workspaceHash: `concurrent-${round}` });
            const results = await Promise.all(Array.from({ length: 30 }, () => schedulerControl.createRecordSchedulerControl({ dataRoot }).cancel(taskId)));
            const invalid = results.filter(result => !["cancelled", "already_cancelled", "cancelling"].includes(result.disposition));
            assert.equal(invalid.length, 0, JSON.stringify(invalid.map(result => ({ disposition: result.disposition, reason: result.reason, state: result.status.taskState }))));
            const ledger = await currentLedger(taskId);
            assert.equal(ledger.task.state, "Cancelled");
            assert.equal(ledger.task.repairState, "None");
        }
    });

    await run("discardLateAttempt outputRef 与 cancel scan 交错时遵守 proof 可见性契约", async () => {
        const retainedTask = await seedTask({
            taskId: "late-output-retained",
            createdAt: iso(-60_000),
            workspaceHash: "late-output-retained",
            running: true,
        });
        const retainedBefore = await currentLedger(retainedTask.taskId);
        await schedulerStore.mutateRecordSchedulerLedger(retainedTask.taskId, retainedBefore.revision, ledger => {
            const unknownOutcomeAt = iso(-30_001);
            ledger.attempts[0]!.state = "UnknownOutcome";
            ledger.attempts[0]!.outcome = "unknown_outcome";
            ledger.attempts[0]!.unknownOutcomeAt = unknownOutcomeAt;
            ledger.attempts[0]!.unknownOutcomeUntil = new Date(Date.parse(unknownOutcomeAt) + 30_000).toISOString();
            ledger.attempts[0]!.unknownOutcomeGraceMs = 30_000;
            ledger.attempts[0]!.errorClass = "UnknownOutcome";
            ledger.attempts[0]!.providerEvidence = "provider acknowledgement unavailable";
            ledger.units[0]!.state = "UnknownOutcome";
            ledger.task.units.running = 0;
        });

        const retainedBeforeReached = deferred();
        const retainedBeforeResume = deferred();
        const retainedAfterReached = deferred();
        const retainedAfterResume = deferred();
        let retainedPauseBefore = true;
        let retainedPauseAfter = true;
        const retainedSpool = schedulerSpool.createRecordSchedulerSpool({
            dataRoot,
            proofVerifier: {
                verifyTaskCancellation: async () => true,
                verifyBlobRelease: async () => true,
            },
            faultInjector: async event => {
                if (retainedPauseBefore && event.point === "before-cancel-scan") {
                    retainedPauseBefore = false;
                    retainedBeforeReached.resolve();
                    await retainedBeforeResume.promise;
                }
                if (retainedPauseAfter && event.point === "after-cancel-scan") {
                    retainedPauseAfter = false;
                    retainedAfterReached.resolve();
                    await retainedAfterResume.promise;
                }
            },
        });
        await retainedSpool.initializeRoot({ mode: "open" });
        await retainedSpool.initializeTask({ taskId: retainedTask.taskId, mode: "open" });
        const retainedOutput = await retainedSpool.writeImmutable({ taskId: retainedTask.taskId, kind: "output", content: "late retained output" });
        const retainedOutputPath = path.join(dataRoot, ...retainedOutput.reference.path.split("/"));
        const retainedControl = schedulerControl.createRecordSchedulerControl({ dataRoot, spool: retainedSpool });
        const retainedCancel = retainedControl.cancel(retainedTask.taskId);
        await retainedBeforeReached.promise;
        await retainedControl.discardLateAttempt({
            taskId: retainedTask.taskId,
            attemptId: "late-output-retained-attempt",
            outputRef: retainedOutput.reference,
        });
        retainedBeforeResume.resolve();
        await retainedAfterReached.promise;
        await fs.access(retainedOutputPath);
        retainedAfterResume.resolve();
        const retainedResult = await retainedCancel;
        assert.equal(retainedResult.disposition, "cancelled", retainedResult.reason);
        assert.equal(retainedResult.status.taskState, "Cancelled");
        assert.equal(retainedResult.status.state, "Cancelled");
        assert.ok(retainedResult.evidence);
        await assert.rejects(() => fs.access(retainedOutputPath));

        const exactTask = await seedTask({ taskId: "late-output-exact-proof", createdAt: iso(), workspaceHash: "late-output-exact-proof", running: true });
        const exactBeforeReached = deferred();
        const exactBeforeResume = deferred();
        const exactAfterReached = deferred();
        const exactAfterResume = deferred();
        let exactPauseBefore = true;
        let exactPauseAfter = true;
        const exactSpool = schedulerSpool.createRecordSchedulerSpool({
            dataRoot,
            proofVerifier: {
                verifyTaskCancellation: async () => true,
                verifyBlobRelease: async () => true,
            },
            faultInjector: async event => {
                if (exactPauseBefore && event.point === "before-cancel-scan") {
                    exactPauseBefore = false;
                    exactBeforeReached.resolve();
                    await exactBeforeResume.promise;
                }
                if (exactPauseAfter && event.point === "after-cancel-scan") {
                    exactPauseAfter = false;
                    exactAfterReached.resolve();
                    await exactAfterResume.promise;
                }
            },
        });
        const exactControl = schedulerControl.createRecordSchedulerControl({ dataRoot, spool: exactSpool });
        assert.equal((await exactControl.cancel(exactTask.taskId)).disposition, "cancelling");
        await exactSpool.initializeRoot({ mode: "open" });
        await exactSpool.initializeTask({ taskId: exactTask.taskId, mode: "open" });
        const exactOutput = await exactSpool.writeImmutable({ taskId: exactTask.taskId, kind: "output", content: "late exact output" });
        const exactOutputPath = path.join(dataRoot, ...exactOutput.reference.path.split("/"));
        await exactControl.discardLateAttempt({
            taskId: exactTask.taskId,
            attemptId: "late-output-exact-proof-attempt",
            outputRef: exactOutput.reference,
        });
        const exactCancel = exactControl.cancel(exactTask.taskId);
        await exactBeforeReached.promise;
        await fs.access(exactOutputPath);
        exactBeforeResume.resolve();
        await exactAfterReached.promise;
        await assert.rejects(() => fs.access(exactOutputPath));
        exactAfterResume.resolve();
        const exactResult = await exactCancel;
        assert.equal(exactResult.disposition, "cancelled", exactResult.reason);
        assert.equal(exactResult.status.taskState, "Cancelled");
        assert.equal(exactResult.status.state, "Cancelled");
    });

    await run("spool 缺失不提前 Cancelled，而是 Cancelling + RepairRequired", async () => {
        const missing = await seedTask({ taskId: "spool-missing", createdAt: iso(), workspaceHash: "spool-missing" });
        await fs.rm(path.join(dataRoot, ".record-scheduler-spool-v2"), { recursive: true, force: true });
        const result = await control.cancel(missing.taskId);
        assert.equal(result.disposition, "repair_required");
        assert.equal(result.status.taskState, "Cancelling");
        assert.equal(result.status.state, "RepairRequired");
    });

    console.log("✅ record-scheduler-control 覆盖 namespace、损坏账本、取消/重启、proof、共享 work、owner fencing 与 UnknownOutcome");
} finally {
    await fs.rm(dataRoot, { recursive: true, force: true });
}
