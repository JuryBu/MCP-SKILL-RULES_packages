import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hardExitChild = process.argv[2] === "--hard-exit-child";
const hardExitOnly = process.argv[2] === "--hard-exit-only";
const dataRoot = hardExitChild
    ? path.resolve(process.argv[3])
    : fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-commit-storage-adapter-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const contracts = await import("../src/record-scheduler-contracts.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");
const schedulerSpool = await import("../src/record-scheduler-spool.ts");
const registry = await import("../src/record-work-registry.ts");
const protocolModule = await import("../src/record-commit-protocol.ts");
const adapterModule = await import("../src/record-commit-storage-adapter.ts");
const recordStore = await import("../src/record-store.ts");
const readerStore = await import("../src/record-update-coordination.ts");

const timestamp = "2034-01-02T03:04:05.000Z";
const nowMs = Date.parse(timestamp);
const hardExitNowMs = Date.parse("2020-01-02T03:04:05.000Z");

class Clock {
    constructor(private value = nowMs) {}

    now(): string {
        return new Date(this.value).toISOString();
    }

    nowMs(): number {
        return this.value;
    }

    advance(milliseconds: number): void {
        this.value += milliseconds;
    }
}

function sha256(value: string): string {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalJson(value: import("../src/record-commit-protocol.ts").JsonValue): string {
    if (value === null) return "null";
    if (typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") return JSON.stringify(value);
    if (typeof value === "boolean") return value ? "true" : "false";
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
    return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

function sealProtocolLedger(
    ledger: Omit<import("../src/record-commit-protocol.ts").RecordCommitLedger, "integrityHash">,
): import("../src/record-commit-protocol.ts").RecordCommitLedger {
    return { ...ledger, integrityHash: sha256(canonicalJson(ledger as unknown as import("../src/record-commit-protocol.ts").JsonValue)) };
}

function portable(value: string): string {
    return value.split(path.sep).join("/");
}

function postFakeProvider(): void {
    const counterPath = path.join(dataRoot, "fake-provider-post-count.txt");
    const count = fs.existsSync(counterPath) ? Number(fs.readFileSync(counterPath, "utf8")) : 0;
    fs.writeFileSync(counterPath, String(count + 1), "utf8");
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, label: string, timeoutMs = 1_000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<T>((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}

function makeInitialLedger(input: {
    taskId: string;
    identity: { chain: "codex"; workspaceHash: string; conversationId: string };
    recordWorkKey: string;
    outputRef: { path: string; hash: string; byteLength: number };
    sourceRef: { path: string; hash: string; byteLength: number };
    desiredRevision: string;
    inputHash: string;
}) {
    const { taskId, identity, recordWorkKey, outputRef, sourceRef, desiredRevision, inputHash } = input;
    const sourceId = `${taskId}-source`;
    const unitId = `${taskId}-unit`;
    const attemptId = `${taskId}-attempt`;
    return {
        schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger" as const,
        revision: 1,
        persistedHash: "",
        task: {
            taskId,
            schedulerEpoch: 1,
            state: "Running" as const,
            requestMode: "batch_update" as const,
            candidateSnapshotId: `${taskId}-candidate`,
            candidateSnapshotRevision: 1,
            admissionIdentity: { requestKey: `${taskId}-request`, requestHash: sha256(`${taskId}-request`) },
            admission: { state: "LedgerCreated" as const },
            createdAt: timestamp,
            updatedAt: timestamp,
            repairState: "None" as const,
            recordItems: { total: 1, succeeded: 0, failed: 0, unresolved: 0 },
            units: { materialized: 1, eligible: 1, running: 1, done: 0, failed: 0 },
            aheadTaskCount: 0,
        },
        candidateSnapshot: {
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            snapshotId: `${taskId}-candidate`,
            snapshotRevision: 1,
            snapshotHash: `${taskId}-candidate-hash`,
            snapshotRef: { path: `record-recovery/${taskId}/candidate.json`, hash: `${taskId}-candidate-hash`, byteLength: 1 },
            createdAt: timestamp,
            requestMode: "normal" as const,
            filters: {},
            enumerations: [{ chain: "codex" as const, complete: true, paginationExhausted: true, truncated: false }],
            candidates: [{
                conversationId: identity.conversationId,
                chain: identity.chain,
                workspaceHash: identity.workspaceHash,
                state: "Missing" as const,
                evidence: ["test"],
                evidenceHash: `${taskId}-candidate-evidence`,
            }],
        },
        sourceSnapshots: [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            sourceSnapshotId: sourceId,
            snapshotRevision: 1,
            snapshotHash: `${taskId}-source-meta`,
            snapshotRef: { path: `record-recovery/${taskId}/source.json`, hash: `${taskId}-source-meta`, byteLength: 1 },
            conversationId: identity.conversationId,
            chain: identity.chain,
            workspaceHash: identity.workspaceHash,
            sourceRevision: desiredRevision,
            desiredRevision,
            contentHash: sourceRef.hash,
            contentRef: sourceRef,
            formatterVersion: "test",
            readRange: { startRound: 1, endRound: 1, totalRounds: 1 },
            complete: true,
            gaps: [],
            parseWarnings: [],
        }],
        recordWork: [{
            recordWorkKey,
            conversationId: identity.conversationId,
            chain: identity.chain,
            workspaceHash: identity.workspaceHash,
            desiredRevision,
            recordCommitEpoch: 1,
            registryRevision: 1,
            registryRef: { path: `record-work/${taskId}.json`, hash: `${taskId}-registry`, byteLength: 1 },
            schedulerEpoch: 1,
            workLeaseId: `${taskId}-bootstrap-lease`,
            leaseOwnerId: "bootstrap",
            leaseExpiresAt: new Date(nowMs + 60_000).toISOString(),
            activeTaskIds: [taskId],
            currentFencingToken: 1,
        }],
        units: [{
            unitId,
            taskId,
            recordId: identity.conversationId,
            state: "Running" as const,
            layer: "record" as const,
            splitDepth: 0,
            recordWorkKey,
            recordCommitEpoch: 1,
            dependencies: [],
            composeOrder: 0,
            sourceSnapshotId: sourceId,
            inputHash,
            estimatedCost: 1,
            routePlan: ["grok" as const],
            attemptedProviders: ["grok" as const],
            retryBudget: 1,
            enqueueTime: timestamp,
            layerEnterTime: timestamp,
        }],
        attempts: [{
            attemptId,
            unitId,
            recordWorkKey,
            originTaskIds: [taskId],
            activeTaskIds: [taskId],
            state: "DispatchIntentPersisted" as const,
            provider: "grok" as const,
            model: "grok-4.5",
            dispatchIntentAt: timestamp,
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: `record-recovery/${taskId}/attempt.json`, hash: `${taskId}-attempt-intent`, byteLength: 1 },
            inputHash,
            fence: {
                schedulerEpoch: 1,
                recordCommitEpoch: 1,
                fencingToken: 1,
                workLeaseId: `${taskId}-bootstrap-lease`,
            },
        }],
        commits: [],
    };
}

async function setup(
    label: string,
    options: {
        hooks?: Parameters<typeof adapterModule.createRecordCommitStorageAdapter>[0]["hooks"];
        clockStart?: number;
        schedulerLeaseDurationMs?: number;
        workLeaseDurationMs?: number;
        taskId?: string;
        identity?: { chain: "codex"; workspaceHash: string; conversationId: string };
        desiredRevision?: string;
        recordStoreHash?: string;
        firstPublicationToken?: string;
        body?: string;
        inputHash?: string;
        commitId?: string;
        recordMeta?: Partial<import("../src/record-store.ts").RecordIndexEntry>;
    } = {},
) {
    const taskId = options.taskId || `task-${label}`;
    const identity = options.identity || { chain: "codex" as const, workspaceHash: `workspace-${label}`, conversationId: `conversation-${label}` };
    const desiredRevision = options.desiredRevision || "revision-1";
    const inputHash = options.inputHash || `${taskId}-input`;
    const recordStoreHash = options.recordStoreHash || `records-${label}`;
    const clock = new Clock(options.clockStart);
    const spool = schedulerSpool.createRecordSchedulerSpool({ dataRoot });
    await spool.initializeRoot({ mode: "create" });
    await spool.initializeTask({ taskId, mode: "create" });
    const source = await spool.writeImmutable({ taskId, kind: "source", content: `source-${label}` });
    const body = options.body || `# ${label}\n\n真实 spool 正文`;
    const output = await spool.writeImmutable({ taskId, kind: "output", content: body });
    const recordWorkKey = registry.recordWorkKey(identity, desiredRevision);
    const initial = makeInitialLedger({ taskId, identity, recordWorkKey, outputRef: output.reference, sourceRef: source.reference, desiredRevision, inputHash });
    initial.persistedHash = schedulerStore.calculateRecordSchedulerLedgerHash(initial);
    const created = await schedulerStore.createRecordSchedulerLedger(initial);
    const ready = await schedulerStore.mutateRecordSchedulerLedger(taskId, created.revision, ledger => {
        ledger.units[0].state = "ResultReady";
        ledger.task.units.running = 0;
        ledger.attempts[0].state = "KnownSuccess";
        ledger.attempts[0].outcome = "known_success";
        ledger.attempts[0].startedAt = timestamp;
        ledger.attempts[0].leaseExpiresAt = new Date(nowMs + 60_000).toISOString();
        ledger.attempts[0].outputRef = output.reference;
    });
    const claimed = await schedulerStore.claimSchedulerOwnerLease(taskId, ready.revision, `owner-${label}`, { nowMs: clock.nowMs(), leaseMs: options.schedulerLeaseDurationMs ?? 120_000 });
    const adapter = await adapterModule.createRecordCommitStorageAdapter({
        taskId,
        work: {
            identity,
            desiredRevision,
            firstPublicationToken: options.firstPublicationToken || `first-publication-${label}`,
            leaseDurationMs: options.workLeaseDurationMs ?? 120_000,
        },
        paths: { dataRoot, recordStoreHash },
        clock,
        schedulerOwnerLease: claimed.ownerLease,
        spool,
        recordMeta: options.recordMeta,
        hooks: options.hooks,
    });
    const current = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs: clock.nowMs() });
    assert.equal(current.kind, "current");
    if (current.kind !== "current") throw new Error("scheduler ledger is unavailable");
    const work = current.ledger.recordWork[0];
    const unit = current.ledger.units[0];
    const attempt = current.ledger.attempts[0];
    const binding = {
        conversationKey: `${identity.chain}:${identity.workspaceHash}:${identity.conversationId}`,
        conversationId: identity.conversationId,
        recordId: identity.conversationId,
        taskId,
        unitId: unit.unitId,
        attemptId: attempt.attemptId,
        recordWorkKey: work.recordWorkKey,
        workLeaseId: work.workLeaseId,
        recordCommitEpoch: work.recordCommitEpoch,
        fencingToken: work.currentFencingToken,
        contentHash: output.reference.hash,
        sourceSnapshotId: unit.sourceSnapshotId,
        inputHash: unit.inputHash,
    };
    const bodyRef = {
        kind: "immutable_record_body" as const,
        conversationId: binding.conversationId,
        recordId: binding.recordId,
        objectId: `${output.reference.hash}:${output.reference.byteLength}`,
        relativePath: output.reference.path,
    };
    const commitId = options.commitId || `commit-${label}`;
    const payload = {
        bodyRef,
        bodyHash: output.reference.hash,
        byteLength: output.reference.byteLength,
        coveredRevision: desiredRevision,
        bodyTarget: {
            kind: "record_body" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("record_body", binding.conversationId),
        },
        mainIndexTarget: {
            kind: "main_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("main_index", binding.conversationId),
        },
        mainIndexEntry: { commitId, coveredRevision: desiredRevision, conversationId: binding.conversationId, recordId: binding.recordId },
        readerIndexTarget: {
            kind: "reader_index" as const,
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("reader_index", binding.conversationId),
        },
        readerIndex: { commitId, bodyHash: output.reference.hash, coveredRevision: desiredRevision, conversationId: binding.conversationId, recordId: binding.recordId },
    };
    return { adapter, body, binding, commitId, payload, taskId, clock, identity, desiredRevision, recordStoreHash, schedulerOwnerLease: claimed.ownerLease, spool };
}

async function requestSchedulerCancellation(fixture: Awaited<ReturnType<typeof setup>>): Promise<void> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
        const current = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true, nowMs: fixture.clock.nowMs() });
        assert.equal(current.kind, "current");
        if (current.kind !== "current" || !current.ledger.schedulerOwner) throw new Error("scheduler owner lease is unavailable for cancellation");
        if (["CancelRequested", "Cancelling", "Cancelled"].includes(current.ledger.task.state)) return;
        try {
            await schedulerStore.mutateRecordSchedulerLedgerAsOwner(
                fixture.taskId,
                current.ledger.revision,
                current.ledger.schedulerOwner,
                ledger => {
                    ledger.task.state = "CancelRequested";
                    ledger.task.cancelRequestedAt = fixture.clock.now();
                    ledger.task.updatedAt = fixture.clock.now();
                },
                { nowMs: fixture.clock.nowMs() },
            );
            return;
        } catch (error) {
            if (!(error instanceof schedulerStore.SchedulerLedgerConflictError)) throw error;
        }
    }
    throw new Error("scheduler cancellation CAS retries exhausted");
}

async function syncRegistryWorkToScheduler(
    fixture: Awaited<ReturnType<typeof setup>>,
    registryState: { path: string; registry: { registryRevision: number; persistedHash: string }; work: { activeTaskIds: string[]; currentFencingToken: number; ownerLease: { workLeaseId: string; ownerId: string; schedulerEpoch: number; expiresAt: string } | null } },
): Promise<void> {
    const current = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true, nowMs: fixture.clock.nowMs() });
    assert.equal(current.kind, "current");
    if (current.kind !== "current" || !current.ledger.schedulerOwner || !registryState.work.ownerLease) throw new Error("scheduler/registry owner lease is unavailable");
    const registryStat = fs.statSync(registryState.path);
    await schedulerStore.mutateRecordSchedulerLedgerAsOwner(fixture.taskId, current.ledger.revision, current.ledger.schedulerOwner, ledger => {
        const schedulerWork = ledger.recordWork[0];
        schedulerWork.registryRevision = registryState.registry.registryRevision;
        schedulerWork.registryRef = {
            path: portable(path.relative(dataRoot, registryState.path)),
            hash: registryState.registry.persistedHash,
            byteLength: registryStat.size,
        };
        schedulerWork.workLeaseId = registryState.work.ownerLease.workLeaseId;
        schedulerWork.leaseOwnerId = registryState.work.ownerLease.ownerId;
        schedulerWork.schedulerEpoch = registryState.work.ownerLease.schedulerEpoch;
        schedulerWork.leaseExpiresAt = registryState.work.ownerLease.expiresAt;
        schedulerWork.activeTaskIds = [...registryState.work.activeTaskIds];
        schedulerWork.currentFencingToken = registryState.work.currentFencingToken;
        for (const attempt of ledger.attempts) {
            if (attempt.recordWorkKey !== schedulerWork.recordWorkKey) continue;
            attempt.fence = {
                schedulerEpoch: schedulerWork.schedulerEpoch,
                recordCommitEpoch: schedulerWork.recordCommitEpoch,
                fencingToken: schedulerWork.currentFencingToken,
                workLeaseId: schedulerWork.workLeaseId,
            };
        }
    }, { nowMs: fixture.clock.nowMs() });
}

async function publishHigherEpochArtifacts(
    fixture: Awaited<ReturnType<typeof setup>>,
    recordCommitEpoch: number,
    commitId: string,
): Promise<{ body: string; bodyHash: string; mainEntry: Record<string, string>; readerEntry: Record<string, string> }> {
    const body = `# higher epoch body ${commitId}`;
    const bodyHash = sha256(body);
    const coveredRevision = "revision-2";
    const identity = {
        conversationId: fixture.binding.conversationId,
        recordId: fixture.binding.recordId,
        commitId,
        coveredRevision,
        bodyHash,
        recordCommitEpoch,
    };
    const currentBody = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    const bodyWrite = await recordStore.writeRecordCommitBodyConditionally({
        hash: fixture.recordStoreHash,
        target: fixture.payload.bodyTarget,
        identity,
        body,
        expected: currentBody,
        validateOwnership: async () => true,
    });
    assert.equal(bodyWrite.kind, "applied");
    const mainEntry = {
        commitId,
        coveredRevision,
        conversationId: fixture.binding.conversationId,
        recordId: fixture.binding.recordId,
    };
    const currentMain = await recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget);
    const mainWrite = await recordStore.writeRecordCommitMainIndexConditionally({
        hash: fixture.recordStoreHash,
        target: fixture.payload.mainIndexTarget,
        identity,
        entry: mainEntry,
        expected: currentMain,
        validateOwnership: async () => true,
    });
    assert.equal(mainWrite.kind, "applied");
    const readerEntry = { ...mainEntry, bodyHash };
    const currentReader = await readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget);
    const readerWrite = await readerStore.writeRecordCommitReaderIndexConditionally({
        hash: fixture.recordStoreHash,
        target: fixture.payload.readerIndexTarget,
        identity,
        index: readerEntry,
        expected: currentReader,
        validateOwnership: async () => true,
    });
    assert.equal(readerWrite.kind, "applied");
    return { body, bodyHash, mainEntry, readerEntry };
}

async function testAtomicCreateCancellationRaces(): Promise<void> {
    const cancelledBefore = await setup("cancel-before-create");
    await requestSchedulerCancellation(cancelledBefore);
    const beforeProtocol = new protocolModule.RecordCommitProtocol(cancelledBefore.adapter);
    await assert.rejects(
        beforeProtocol.create({ commitId: cancelledBefore.commitId, binding: cancelledBefore.binding, payload: cancelledBefore.payload }),
        (error: unknown) => error instanceof protocolModule.RecordCommitInitialGuardRejectedError && error.guard === "cancelled",
    );
    const beforeLedger = await schedulerStore.readRecordSchedulerLedgerStore(cancelledBefore.taskId, { expectPublished: true, nowMs: cancelledBefore.clock.nowMs() });
    assert.equal(beforeLedger.kind, "current");
    if (beforeLedger.kind !== "current") throw new Error("cancel-before scheduler ledger disappeared");
    assert.equal(beforeLedger.ledger.commits.some(commit => commit.commitId === cancelledBefore.commitId), false);

    const simultaneousEntered = deferred();
    const simultaneousRelease = deferred();
    let simultaneousBlocked = false;
    const simultaneous = await setup("cancel-simultaneous-create", {
        hooks: {
            onProtocolCasPoint: async input => {
                if (!input.initialGuard || input.point !== "after_scheduler_read" || simultaneousBlocked) return;
                simultaneousBlocked = true;
                simultaneousEntered.resolve();
                await simultaneousRelease.promise;
            },
        },
    });
    const simultaneousProtocol = new protocolModule.RecordCommitProtocol(simultaneous.adapter);
    const racingCreate = simultaneousProtocol.create({ commitId: simultaneous.commitId, binding: simultaneous.binding, payload: simultaneous.payload });
    await simultaneousEntered.promise;
    await requestSchedulerCancellation(simultaneous);
    simultaneousRelease.resolve();
    await assert.rejects(
        racingCreate,
        (error: unknown) => error instanceof protocolModule.RecordCommitInitialGuardRejectedError && error.guard === "cancelled",
    );
    const simultaneousLedger = await schedulerStore.readRecordSchedulerLedgerStore(simultaneous.taskId, { expectPublished: true, nowMs: simultaneous.clock.nowMs() });
    assert.equal(simultaneousLedger.kind, "current");
    if (simultaneousLedger.kind !== "current") throw new Error("simultaneous scheduler ledger disappeared");
    assert.equal(simultaneousLedger.ledger.commits.some(commit => commit.commitId === simultaneous.commitId), false);

    const createEntered = deferred();
    const createRelease = deferred();
    let createBlocked = false;
    const createFirst = await setup("create-before-cancel", {
        hooks: {
            onProtocolCasPoint: async input => {
                if (!input.initialGuard || input.point !== "owner_lock_acquired" || createBlocked) return;
                createBlocked = true;
                createEntered.resolve();
                await createRelease.promise;
            },
        },
    });
    const createFirstProtocol = new protocolModule.RecordCommitProtocol(createFirst.adapter);
    const createPromise = createFirstProtocol.create({ commitId: createFirst.commitId, binding: createFirst.binding, payload: createFirst.payload });
    await createEntered.promise;
    const cancelPromise = requestSchedulerCancellation(createFirst);
    createRelease.resolve();
    const [created] = await Promise.all([createPromise, cancelPromise]);
    assert.equal(created.stage, "ResultReady");
    const cancelled = await createFirstProtocol.recover(createFirst.commitId);
    assert.equal(cancelled.kind, "cancelled");
}

async function testDualSchedulerAndProtocolCas(): Promise<void> {
    const makeNext = (
        current: import("../src/record-commit-protocol.ts").RecordCommitLedger,
        detail: string,
    ): import("../src/record-commit-protocol.ts").RecordCommitLedger => {
        const { integrityHash: _integrityHash, ...withoutHash } = current;
        return sealProtocolLedger({
            ...withoutHash,
            revision: current.revision + 1,
            audit: [...current.audit, { at: current.updatedAt, kind: "late_result_discarded", detail }],
        });
    };

    const sameSchedulerEntered = deferred();
    const sameSchedulerRelease = deferred();
    let sameSchedulerReaders = 0;
    const differentProtocolRevision = await setup("dual-cas-protocol-revision", {
        hooks: {
            onProtocolCasPoint: async input => {
                if (input.initialGuard || input.point !== "after_scheduler_read") return;
                sameSchedulerReaders += 1;
                if (sameSchedulerReaders === 2) sameSchedulerEntered.resolve();
                await sameSchedulerRelease.promise;
            },
        },
    });
    const protocolRevisionProtocol = new protocolModule.RecordCommitProtocol(differentProtocolRevision.adapter);
    const protocolRevisionBase = await protocolRevisionProtocol.create({
        commitId: differentProtocolRevision.commitId,
        binding: differentProtocolRevision.binding,
        payload: differentProtocolRevision.payload,
    });
    const validNext = makeNext(protocolRevisionBase, "valid-protocol-revision");
    const staleNext = makeNext(protocolRevisionBase, "stale-protocol-revision");
    const validCas = differentProtocolRevision.adapter.durable.compareAndSwapLedger(
        differentProtocolRevision.commitId,
        protocolRevisionBase.revision,
        validNext,
    );
    const staleCas = differentProtocolRevision.adapter.durable.compareAndSwapLedger(
        differentProtocolRevision.commitId,
        protocolRevisionBase.revision - 1,
        staleNext,
    );
    await sameSchedulerEntered.promise;
    sameSchedulerRelease.resolve();
    const differentRevisionResults = await Promise.all([validCas, staleCas]);
    assert.deepEqual(differentRevisionResults.map(result => result.kind).sort(), ["conflict", "written"]);

    const advancedSchedulerEntered = deferred();
    const advancedSchedulerRelease = deferred();
    let advancedSchedulerReaders = 0;
    const schedulerAdvanced = await setup("dual-cas-scheduler-revision", {
        hooks: {
            onProtocolCasPoint: async input => {
                if (input.initialGuard || input.point !== "after_scheduler_read") return;
                advancedSchedulerReaders += 1;
                if (advancedSchedulerReaders === 2) advancedSchedulerEntered.resolve();
                await advancedSchedulerRelease.promise;
            },
        },
    });
    const schedulerAdvancedProtocol = new protocolModule.RecordCommitProtocol(schedulerAdvanced.adapter);
    const schedulerAdvancedBase = await schedulerAdvancedProtocol.create({
        commitId: schedulerAdvanced.commitId,
        binding: schedulerAdvanced.binding,
        payload: schedulerAdvanced.payload,
    });
    const beforeBump = await schedulerStore.readRecordSchedulerLedgerStore(schedulerAdvanced.taskId, { expectPublished: true, nowMs: schedulerAdvanced.clock.nowMs() });
    assert.equal(beforeBump.kind, "current");
    if (beforeBump.kind !== "current" || !beforeBump.ledger.schedulerOwner) throw new Error("scheduler CAS fixture lost owner");
    await schedulerStore.mutateRecordSchedulerLedgerAsOwner(
        schedulerAdvanced.taskId,
        beforeBump.ledger.revision,
        beforeBump.ledger.schedulerOwner,
        ledger => { ledger.task.updatedAt = schedulerAdvanced.clock.now(); },
        { nowMs: schedulerAdvanced.clock.nowMs() },
    );
    const schedulerNextA = makeNext(schedulerAdvancedBase, "scheduler-bump-a");
    const schedulerNextB = makeNext(schedulerAdvancedBase, "scheduler-bump-b");
    const schedulerCasA = schedulerAdvanced.adapter.durable.compareAndSwapLedger(
        schedulerAdvanced.commitId,
        schedulerAdvancedBase.revision,
        schedulerNextA,
    );
    const schedulerCasB = schedulerAdvanced.adapter.durable.compareAndSwapLedger(
        schedulerAdvanced.commitId,
        schedulerAdvancedBase.revision,
        schedulerNextB,
    );
    await advancedSchedulerEntered.promise;
    advancedSchedulerRelease.resolve();
    const advancedResults = await Promise.all([schedulerCasA, schedulerCasB]);
    assert.deepEqual(advancedResults.map(result => result.kind).sort(), ["conflict", "written"]);
    const recovered = await schedulerAdvancedProtocol.recover(schedulerAdvanced.commitId);
    assert.equal(recovered.kind, "verified");
}

async function testNormalCommit(): Promise<void> {
    const fixture = await setup("normal");
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    const created = await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    assert.equal(created.stage, "ResultReady");
    const recovered = await protocol.recover(fixture.commitId);
    assert.equal(recovered.kind, "verified");

    const body = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    const main = await recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget);
    const reader = await readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget);
    assert.equal(body.body, fixture.body);
    assert.equal(body.ownerCommitId, fixture.commitId);
    assert.deepEqual(main.value, fixture.payload.mainIndexEntry);
    assert.deepEqual(reader.value, fixture.payload.readerIndex);

    const stored = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true, nowMs: fixture.clock.nowMs() });
    assert.equal(stored.kind, "current");
    if (stored.kind !== "current") throw new Error("scheduler ledger missing after commit");
    const commit = stored.ledger.commits.find(candidate => candidate.commitId === fixture.commitId) as { protocolLedger?: unknown } | undefined;
    assert.ok(commit?.protocolLedger);
    assert.equal(JSON.stringify(commit?.protocolLedger).includes(fixture.body), false, "scheduler ledger 只能保存 bodyRef，不得序列化正文");
    assert.equal(stored.ledger.commits[0].state, "Verified");
    assert.equal(stored.ledger.units[0].state, "Succeeded");
}

async function testCommitAuthorityBlocksExpiredLeaseTakeover(): Promise<void> {
    const authorityEntered = deferred();
    const authorityRelease = deferred();
    let authorityBlocked = false;
    const fixture = await setup("commit-authority-interleave", {
        schedulerLeaseDurationMs: 240_000,
        workLeaseDurationMs: 10_000,
        hooks: {
            onCommitAuthorityHeld: async () => {
                if (authorityBlocked) return;
                authorityBlocked = true;
                authorityEntered.resolve();
                await authorityRelease.promise;
            },
        },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    const location = { identity: fixture.identity, dataRoot };
    const beforeTakeover = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeTakeover.kind, "ready");
    if (beforeTakeover.kind !== "ready") throw new Error("registry unavailable before commit authority is held");
    const publishing = protocol.recover(fixture.commitId);
    await authorityEntered.promise;

    const takeoverNowMs = fixture.clock.nowMs() + 10_001;
    let takeoverSettled = false;
    const takeover = registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: fixture.binding.recordWorkKey,
        taskId: fixture.taskId,
        ownerId: "owner-commit-authority-takeover",
        schedulerEpoch: 2,
        expectedRegistryRevision: beforeTakeover.registry.registryRevision - 1,
        workLeaseId: "commit-authority-takeover-lease",
        leaseDurationMs: 120_000,
        nowMs: takeoverNowMs,
    }).finally(() => { takeoverSettled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    assert.equal(takeoverSettled, false, "A 持有 artifact/registry 临界区时，B 不得接管已过期 lease");

    authorityRelease.resolve();
    const published = await publishing;
    assert.equal(published.kind, "verified", JSON.stringify(published));
    const takenOver = await takeover;
    assert.equal(takenOver.kind, "cas_conflict", "A 写后才处理并拒绝 B 的过期 CAS lease 接管请求");
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.ownerCommitId, fixture.commitId);
    assert.equal(main.ownerCommitId, fixture.commitId);
    assert.equal(reader.ownerCommitId, fixture.commitId);
}

async function testPublishTakeoverLockOrderCompletesWithoutCycle(): Promise<void> {
    const artifactLockEntered = deferred();
    const artifactLockRelease = deferred();
    let artifactLockBlocked = false;
    const fixture = await setup("publish-lock-order", {
        schedulerLeaseDurationMs: 240_000,
        workLeaseDurationMs: 10_000,
        hooks: {
            onArtifactLockHeldBeforeRegistryAuthority: async input => {
                if (input.detachedCleanup || artifactLockBlocked) return;
                artifactLockBlocked = true;
                artifactLockEntered.resolve();
                await artifactLockRelease.promise;
            },
        },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    assert.equal((await protocol.advanceOnce(fixture.commitId)).kind, "advanced");
    assert.equal((await protocol.advanceOnce(fixture.commitId)).kind, "advanced");
    const publishIntent = await protocol.read(fixture.commitId);
    assert.equal(publishIntent.stage, "PublishIntent");
    const location = { identity: fixture.identity, dataRoot };
    const publishing = fixture.adapter.io.publishBody({
        commitId: fixture.commitId,
        binding: fixture.binding,
        target: publishIntent.payload.bodyTarget,
        bodyRef: publishIntent.payload.bodyRef,
        bodyHash: publishIntent.payload.bodyHash,
        byteLength: publishIntent.payload.byteLength,
        maxBytes: Number.MAX_SAFE_INTEGER,
        coveredRevision: publishIntent.payload.coveredRevision,
    });
    await settleWithin(artifactLockEntered.promise, "publish artifact lock entry");
    const duringPublish = await settleWithin(registry.readRecordWorkRegistry(location), "registry read while publish holds artifact lock");
    assert.equal(duringPublish.kind, "ready");
    if (duringPublish.kind !== "ready") throw new Error("publish lock-order registry unavailable");
    assert.equal(
        duringPublish.registry.works.find(work => work.recordWorkKey === fixture.binding.recordWorkKey)?.publicationClaim?.commitId,
        fixture.commitId,
        "publication claim must be durable before the artifact lock synchronization point",
    );
    const takeover = await settleWithin(registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: fixture.binding.recordWorkKey,
        taskId: fixture.taskId,
        ownerId: "owner-publish-lock-order-takeover",
        schedulerEpoch: 2,
        expectedRegistryRevision: duringPublish.registry.registryRevision,
        workLeaseId: "publish-lock-order-takeover-lease",
        leaseDurationMs: 120_000,
        nowMs: fixture.clock.nowMs() + 10_001,
    }), "takeover while publish holds artifact lock");
    assert.equal(takeover.kind, "acquired");
    if (takeover.kind !== "acquired") throw new Error("publish lock-order takeover did not acquire");
    artifactLockRelease.resolve();
    await assert.rejects(
        () => settleWithin(publishing, "stale publish after takeover"),
        error => error instanceof protocolModule.RecordCommitVerificationError,
    );
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.body, null, "old fence must not write body after takeover");
    assert.equal(main.value, null);
    assert.equal(reader.value, null);
}

async function testCleanupTakeoverLockOrderCompletesWithoutCycle(): Promise<void> {
    const artifactLockEntered = deferred();
    const artifactLockRelease = deferred();
    let blockCleanupAuthority = false;
    let artifactLockBlocked = false;
    const fixture = await setup("cleanup-lock-order", {
        hooks: {
            onArtifactLockHeldBeforeRegistryAuthority: async input => {
                if (!blockCleanupAuthority || !input.detachedCleanup || artifactLockBlocked) return;
                artifactLockBlocked = true;
                artifactLockEntered.resolve();
                await artifactLockRelease.promise;
            },
        },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    assert.equal((await protocol.recover(fixture.commitId)).kind, "verified");
    const verified = await protocol.read(fixture.commitId);
    if (!verified.beforeImages) throw new Error("cleanup lock-order before images missing");
    blockCleanupAuthority = true;
    const location = { identity: fixture.identity, dataRoot };
    const before = await registry.readRecordWorkRegistry(location);
    assert.equal(before.kind, "ready");
    if (before.kind !== "ready") throw new Error("cleanup lock-order registry unavailable");
    const cleanup = fixture.adapter.io.restoreBodyIfOwned({
        commitId: fixture.commitId,
        binding: fixture.binding,
        target: verified.payload.bodyTarget,
        expected: {
            bodyRef: verified.payload.bodyRef,
            bodyHash: verified.payload.bodyHash,
            byteLength: verified.payload.byteLength,
            ownerCommitId: verified.commitId,
            revision: verified.payload.coveredRevision,
        },
        before: verified.beforeImages.body,
        maxBytes: Number.MAX_SAFE_INTEGER,
    });
    await settleWithin(artifactLockEntered.promise, "cleanup artifact lock entry");
    const successor = await settleWithin(registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: "revision-2",
        taskId: "task-cleanup-lock-order-successor",
        expectedRegistryRevision: before.registry.registryRevision,
        nowMs: fixture.clock.nowMs(),
    }), "successor while cleanup holds artifact lock");
    assert.equal(successor.kind, "started");
    if (successor.kind !== "started") throw new Error("cleanup lock-order successor did not start");
    const successorLease = await settleWithin(registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: successor.work.recordWorkKey,
        taskId: "task-cleanup-lock-order-successor",
        ownerId: "owner-cleanup-lock-order-successor",
        schedulerEpoch: 2,
        expectedRegistryRevision: successor.registry.registryRevision,
        workLeaseId: "cleanup-lock-order-successor-lease",
        leaseDurationMs: 120_000,
        nowMs: fixture.clock.nowMs(),
    }), "successor lease while cleanup holds artifact lock");
    assert.equal(successorLease.kind, "acquired");
    artifactLockRelease.resolve();
    await assert.rejects(
        () => settleWithin(cleanup, "stale cleanup after successor epoch"),
        error => error instanceof protocolModule.RecordCommitVerificationError,
    );
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.ownerCommitId, fixture.commitId, "old cleanup must not rewrite body after successor epoch");
    assert.equal(main.ownerCommitId, fixture.commitId);
    assert.equal(reader.ownerCommitId, fixture.commitId);
}

async function testLostLeaseBeforeAuthorityScopeWritesNothing(): Promise<void> {
    const fixture = await setup("lost-before-authority", {
        schedulerLeaseDurationMs: 240_000,
        workLeaseDurationMs: 10_000,
    });
    const location = { identity: fixture.identity, dataRoot };
    const beforeTakeover = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeTakeover.kind, "ready");
    if (beforeTakeover.kind !== "ready") throw new Error("registry unavailable before stale lease takeover");
    const takeoverNowMs = fixture.clock.nowMs() + 10_001;
    const takenOver = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: fixture.binding.recordWorkKey,
        taskId: fixture.taskId,
        ownerId: "owner-lost-before-authority",
        schedulerEpoch: 2,
        expectedRegistryRevision: beforeTakeover.registry.registryRevision,
        workLeaseId: "lost-before-authority-lease",
        leaseDurationMs: 120_000,
        nowMs: takeoverNowMs,
    });
    assert.equal(takenOver.kind, "acquired");
    if (takenOver.kind !== "acquired") throw new Error("stale lease takeover did not complete");
    await syncRegistryWorkToScheduler(fixture, takenOver);

    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await assert.rejects(
        protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload }),
        error => error instanceof protocolModule.RecordCommitVerificationError,
    );
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.body, null);
    assert.equal(main.value, null);
    assert.equal(reader.value, null);
}

async function testReplacedBodyIsSpoolReferenceOnly(): Promise<void> {
    const fixture = await setup("replace-old-body");
    const oldBody = "OLD-BODY-MUST-ONLY-EXIST-IN-SPOOL-9e7f";
    const oldHash = sha256(oldBody);
    const empty = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    const seeded = await recordStore.writeRecordCommitBodyConditionally({
        hash: fixture.recordStoreHash,
        target: fixture.payload.bodyTarget,
        identity: {
            conversationId: fixture.binding.conversationId,
            recordId: fixture.binding.recordId,
            commitId: "commit-old-body",
            coveredRevision: "revision-0",
            bodyHash: oldHash,
            recordCommitEpoch: fixture.binding.recordCommitEpoch,
        },
        body: oldBody,
        expected: empty,
        validateOwnership: async () => true,
    });
    assert.equal(seeded.kind, "applied");

    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    const recovered = await protocol.recover(fixture.commitId);
    assert.equal(recovered.kind, "verified");
    const protocolLedger = await protocol.read(fixture.commitId);
    const beforeRef = protocolLedger.beforeImages?.body.bodyRef;
    assert.ok(beforeRef, "旧正文必须被转换为 immutable spool ref");
    assert.equal(JSON.stringify(protocolLedger).includes(oldBody), false);

    const stored = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true, nowMs: fixture.clock.nowMs() });
    assert.equal(stored.kind, "current");
    if (stored.kind !== "current") throw new Error("scheduler ledger missing after replacing old body");
    assert.equal(JSON.stringify(stored.ledger).includes(oldBody), false, "scheduler ledger 不得序列化旧正文");
    const separator = beforeRef.objectId.lastIndexOf(":");
    const oldReference = {
        path: beforeRef.relativePath,
        hash: beforeRef.objectId.slice(0, separator),
        byteLength: Number(beforeRef.objectId.slice(separator + 1)),
    };
    const oldBytes = await fixture.spool.readImmutable({ taskId: fixture.taskId, kind: "output", reference: oldReference });
    assert.equal(oldBytes.toString("utf8"), oldBody);
}

async function testWriteBeforeAfterRecovery(): Promise<void> {
    const stages = ["BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified"] as const;
    const points = ["before_write", "after_write"] as const;
    for (const stage of stages) {
        for (const point of points) {
            const fixture = await setup(`crash-${stage}-${point}`);
            const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
            await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
            let injected = false;
            (fixture.adapter as unknown as { hooks?: { onFaultPoint: (input: { stage: string; point: string }) => void } }).hooks = {
                onFaultPoint: input => {
                    if (!injected && input.stage === stage && input.point === point) {
                        injected = true;
                        throw new Error(`simulated ${stage}/${point} crash`);
                    }
                },
            };
            await assert.rejects(() => protocol.recover(fixture.commitId), /simulated/u);
            assert.equal(injected, true, `${stage}/${point} 应经过故障点`);
            (fixture.adapter as unknown as { hooks?: unknown }).hooks = undefined;
            const recovered = await protocol.recover(fixture.commitId);
            assert.equal(recovered.kind, "verified", `${stage}/${point} 重启恢复后必须收敛到 Verified`);
        }
    }
}

async function testDetachedExclusiveCleanup(): Promise<void> {
    const fixture = await setup("exclusive-cleanup");
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);
    const published = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    assert.equal(published.ownerCommitId, fixture.commitId);

    const cancelled = await protocol.cancel(fixture.commitId);
    assert.equal(cancelled.kind, "cancelled");
    const body = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    const main = await recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget);
    const reader = await readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget);
    assert.equal(body.body, null);
    assert.equal(main.value, null);
    assert.equal(reader.value, null);
}

async function testSharedDetachPreservesArtifacts(): Promise<void> {
    const fixture = await setup("shared-detach");
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);

    const location = { identity: fixture.identity, dataRoot };
    const beforeAttach = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeAttach.kind, "ready");
    if (beforeAttach.kind !== "ready") throw new Error("shared registry is unavailable");
    const attached = await registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: fixture.desiredRevision,
        taskId: "task-shared-detach-peer",
        expectedRegistryRevision: beforeAttach.registry.registryRevision,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(attached.kind, "started");
    if (attached.kind !== "started") throw new Error("peer task was not attached");
    await syncRegistryWorkToScheduler(fixture, attached);

    const detached = await protocol.cancel(fixture.commitId);
    assert.equal(detached.kind, "detached");
    const body = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    assert.equal(body.ownerCommitId, fixture.commitId, "共享 peer 仍在时不得清理 A 已写入的 body");
    const afterDetach = await registry.readRecordWorkRegistry(location);
    assert.equal(afterDetach.kind, "ready");
    if (afterDetach.kind !== "ready") throw new Error("shared registry disappeared after detach");
    assert.deepEqual(afterDetach.registry.works.find(work => work.recordWorkKey === fixture.binding.recordWorkKey)?.activeTaskIds, ["task-shared-detach-peer"]);
}

async function testHigherEpochTakeoverStopsOldCleanup(): Promise<void> {
    const fixture = await setup("higher-epoch");
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);
    await protocol.advanceOnce(fixture.commitId);

    const location = { identity: fixture.identity, dataRoot };
    const beforeTakeover = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeTakeover.kind, "ready");
    if (beforeTakeover.kind !== "ready") throw new Error("takeover registry is unavailable");
    const successor = await registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: "revision-2",
        taskId: "task-higher-epoch-successor",
        expectedRegistryRevision: beforeTakeover.registry.registryRevision,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(successor.kind, "started");
    if (successor.kind !== "started") throw new Error("higher epoch work was not created");
    const successorLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: successor.work.recordWorkKey,
        taskId: "task-higher-epoch-successor",
        ownerId: "owner-higher-epoch-successor",
        schedulerEpoch: 2,
        expectedRegistryRevision: successor.registry.registryRevision,
        workLeaseId: "higher-epoch-successor-lease",
        leaseDurationMs: 120_000,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(successorLease.kind, "acquired");
    if (successorLease.kind !== "acquired") throw new Error("higher epoch lease was not acquired");
    assert.ok(successorLease.work.recordCommitEpoch > fixture.binding.recordCommitEpoch);

    const stopped = await protocol.cancel(fixture.commitId);
    assert.equal(stopped.kind, "audited_stale");
    const body = await recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget);
    assert.equal(body.ownerCommitId, fixture.commitId, "B 已取得高 epoch 时不得由 A cleanup 删除旧 artifact");
}

async function testHigherEpochArtifactsSurviveCleanupRestart(): Promise<void> {
    const checkpointEntered = deferred();
    const checkpointRelease = deferred();
    let checkpointBlocked = false;
    const fixture = await setup("higher-epoch-cleanup-restart", {
        hooks: {
            onCleanupCheckpoint: async input => {
                if (input.point !== "before_guard" || checkpointBlocked) return;
                checkpointBlocked = true;
                checkpointEntered.resolve();
                await checkpointRelease.promise;
            },
        },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    assert.equal((await protocol.recover(fixture.commitId)).kind, "verified");
    const cancelling = protocol.cancel(fixture.commitId);
    await checkpointEntered.promise;
    assert.equal((await protocol.read(fixture.commitId)).lifecycle, "Cancelling");

    const location = { identity: fixture.identity, dataRoot };
    const beforeTakeover = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeTakeover.kind, "ready");
    if (beforeTakeover.kind !== "ready") throw new Error("takeover registry unavailable at cleanup checkpoint");
    const successor = await registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: "revision-2",
        taskId: "task-higher-epoch-cleanup-successor",
        expectedRegistryRevision: beforeTakeover.registry.registryRevision,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(successor.kind, "started");
    if (successor.kind !== "started") throw new Error("cleanup successor work was not created");
    const successorLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: successor.work.recordWorkKey,
        taskId: "task-higher-epoch-cleanup-successor",
        ownerId: "owner-higher-epoch-cleanup-successor",
        schedulerEpoch: 2,
        expectedRegistryRevision: successor.registry.registryRevision,
        workLeaseId: "higher-epoch-cleanup-successor-lease",
        leaseDurationMs: 120_000,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(successorLease.kind, "acquired");
    if (successorLease.kind !== "acquired") throw new Error("cleanup successor lease was not acquired");
    const published = await publishHigherEpochArtifacts(fixture, successorLease.work.recordCommitEpoch, "commit-higher-epoch-b");

    const restarted = new protocolModule.RecordCommitProtocol(fixture.adapter);
    const resumed = await restarted.recover(fixture.commitId);
    assert.equal(resumed.kind, "audited_stale");
    checkpointRelease.resolve();
    assert.equal((await cancelling).kind, "audited_stale");

    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.body, published.body);
    assert.equal(body.ownerCommitId, "commit-higher-epoch-b");
    assert.deepEqual(main.value, published.mainEntry);
    assert.deepEqual(reader.value, published.readerEntry);
}

async function testPeerJoinsAfterDetachBeforeCleanup(): Promise<void> {
    const checkpointEntered = deferred();
    const checkpointRelease = deferred();
    let checkpointBlocked = false;
    const fixture = await setup("peer-joins-after-detach", {
        hooks: {
            onCleanupCheckpoint: async input => {
                if (input.point !== "before_guard" || checkpointBlocked) return;
                checkpointBlocked = true;
                checkpointEntered.resolve();
                await checkpointRelease.promise;
            },
        },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    assert.equal((await protocol.recover(fixture.commitId)).kind, "verified");
    const cancelling = protocol.cancel(fixture.commitId);
    await checkpointEntered.promise;
    assert.equal((await protocol.read(fixture.commitId)).lifecycle, "Cancelling");

    const location = { identity: fixture.identity, dataRoot };
    const detachedRegistry = await registry.readRecordWorkRegistry(location);
    assert.equal(detachedRegistry.kind, "ready");
    if (detachedRegistry.kind !== "ready") throw new Error("detached registry unavailable before peer join");
    const peer = await registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: fixture.desiredRevision,
        taskId: "task-peer-after-detach",
        expectedRegistryRevision: detachedRegistry.registry.registryRevision,
        nowMs: fixture.clock.nowMs(),
    });
    assert.equal(peer.kind, "started");
    if (peer.kind !== "started") throw new Error("peer did not attach after A detached");
    await syncRegistryWorkToScheduler(fixture, peer);
    checkpointRelease.resolve();
    const detached = await cancelling;
    assert.equal(detached.kind, "detached");

    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(fixture.recordStoreHash, fixture.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(fixture.recordStoreHash, fixture.payload.readerIndexTarget),
    ]);
    assert.equal(body.ownerCommitId, fixture.commitId);
    assert.equal(main.ownerCommitId, fixture.commitId);
    assert.equal(reader.ownerCommitId, fixture.commitId);
}

async function testLateResultIsolation(): Promise<void> {
    const fixture = await setup("late");
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    const late = await protocol.discardLateResult(
        fixture.commitId,
        fixture.payload.bodyRef,
        fixture.payload.bodyHash,
        fixture.payload.byteLength,
        "late-provider-result",
    );
    assert.equal(late.kind, "audited_stale");
    const lateDirectory = path.join(dataRoot, "record-commit-late");
    const files = fs.readdirSync(lateDirectory);
    assert.equal(files.length, 1);
    const isolated = JSON.parse(fs.readFileSync(path.join(lateDirectory, files[0]), "utf8"));
    assert.equal(isolated.bodyRef.objectId, fixture.payload.bodyRef.objectId);
    assert.equal(JSON.stringify(isolated).includes(fixture.body), false, "迟到结果隔离文件也不得复制正文");
}

async function testSameIdentityWinnerBlocksDifferentBodyAndReusesSameBody(): Promise<void> {
    const identity = { chain: "codex" as const, workspaceHash: "winner-shared-workspace", conversationId: "winner-shared-conversation" };
    const desiredRevision = "revision-1";
    const firstPublicationToken = "first-publication-token-shared-winner";
    const recordStoreHash = "records-shared-winner";
    const sharedBody = "# winner\n\nbody-A";
    const sharedInputHash = "shared-input-hash";
    const taskA = await setup("winner-A", {
        taskId: "task-winner-A",
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        body: sharedBody,
        inputHash: sharedInputHash,
        workLeaseDurationMs: 20,
        recordMeta: { title: "winner A", lastUpdatedAt: timestamp, tags: ["winner"] },
    });
    const protocolA = new protocolModule.RecordCommitProtocol(taskA.adapter);
    await protocolA.create({ commitId: taskA.commitId, binding: taskA.binding, payload: taskA.payload });
    assert.equal((await protocolA.recover(taskA.commitId)).kind, "verified");
    const beforeB = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(recordStoreHash, taskA.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, taskA.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, taskA.payload.readerIndexTarget),
    ]);
    const registryBeforeB = await registry.readRecordWorkRegistry({ identity, dataRoot });
    assert.equal(registryBeforeB.kind, "ready");
    if (registryBeforeB.kind !== "ready") throw new Error("A 发布后 registry 不可读");
    const winnerBeforeB = registryBeforeB.registry.works.find(work => work.recordWorkKey === taskA.binding.recordWorkKey)?.publicationClaim;
    assert.deepEqual(winnerBeforeB && { commitId: winnerBeforeB.commitId, inputHash: winnerBeforeB.inputHash, bodyHash: winnerBeforeB.bodyHash, coveredRevision: winnerBeforeB.coveredRevision }, {
        commitId: taskA.commitId,
        inputHash: sharedInputHash,
        bodyHash: taskA.payload.bodyHash,
        coveredRevision: desiredRevision,
    });

    const sameCommitDifferentTask = await setup("winner-B-same-commit", {
        taskId: "task-winner-B-same-commit",
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        commitId: taskA.commitId,
        body: sharedBody,
        inputHash: sharedInputHash,
        clockStart: nowMs + 100,
        workLeaseDurationMs: 20,
        recordMeta: { title: "same commit id from another task must conflict", lastUpdatedAt: new Date(nowMs + 100).toISOString() },
    });
    const sameCommitProtocol = new protocolModule.RecordCommitProtocol(sameCommitDifferentTask.adapter);
    await sameCommitProtocol.create({ commitId: sameCommitDifferentTask.commitId, binding: sameCommitDifferentTask.binding, payload: sameCommitDifferentTask.payload });
    const rejectedSameCommit = await sameCommitProtocol.recover(sameCommitDifferentTask.commitId);
    assert.equal(rejectedSameCommit.kind, "repair_required", "different task must not continue a winner merely by reusing its commitId");
    if (rejectedSameCommit.kind === "repair_required") assert.match(rejectedSameCommit.ledger.repairState || "", /already_published_conflict/u);

    const taskB = await setup("winner-B-different", {
        taskId: "task-winner-B",
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        body: "# winner\n\nbody-B",
        inputHash: sharedInputHash,
        clockStart: nowMs + 200,
        workLeaseDurationMs: 20,
        recordMeta: { title: "winner B", lastUpdatedAt: new Date(nowMs + 200).toISOString() },
    });
    const protocolB = new protocolModule.RecordCommitProtocol(taskB.adapter);
    await protocolB.create({ commitId: taskB.commitId, binding: taskB.binding, payload: taskB.payload });
    const rejectedB = await protocolB.recover(taskB.commitId);
    assert.equal(rejectedB.kind, "repair_required", "同 identity/revision 的不同正文必须显式进入 RepairRequired，不能改写 winner");
    if (rejectedB.kind === "repair_required") assert.match(rejectedB.ledger.repairState || "", /already_published_conflict/u);
    const afterB = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(recordStoreHash, taskA.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, taskA.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, taskA.payload.readerIndexTarget),
    ]);
    assert.deepEqual(afterB, beforeB, "B 换取更高 fence 后不得改动正文、主索引或 Reader Index");

    const taskC = await setup("winner-C-reuse", {
        taskId: "task-winner-C",
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        body: sharedBody,
        inputHash: sharedInputHash,
        clockStart: nowMs + 300,
        workLeaseDurationMs: 20,
        recordMeta: { title: "different metadata must not overwrite winner", lastUpdatedAt: new Date(nowMs + 300).toISOString() },
    });
    const protocolC = new protocolModule.RecordCommitProtocol(taskC.adapter);
    await protocolC.create({ commitId: taskC.commitId, binding: taskC.binding, payload: taskC.payload });
    assert.equal((await protocolC.recover(taskC.commitId)).kind, "verified", "相同 input/body/revision 的 task 必须复用既有 winner，不得重复写");
    const afterC = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(recordStoreHash, taskA.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, taskA.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, taskA.payload.readerIndexTarget),
    ]);
    assert.deepEqual(afterC, beforeB, "复用必须保持 A 的原始三类 artifact receipt，不得把 owner 改成 C");
    const schedulerA = await schedulerStore.readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true, nowMs: taskA.clock.nowMs() });
    assert.equal(schedulerA.kind, "current");
    if (schedulerA.kind !== "current") throw new Error("A scheduler ledger 不可读");
    assert.equal(schedulerA.ledger.commits.find(commit => commit.commitId === taskA.commitId)?.state, "Verified", "A 的 Verified 状态必须和 winner receipt 保持一致");
    const registryAfterC = await registry.readRecordWorkRegistry({ identity, dataRoot });
    assert.equal(registryAfterC.kind, "ready");
    if (registryAfterC.kind !== "ready") throw new Error("C 复用后 registry 不可读");
    assert.equal(registryAfterC.registry.works.find(work => work.recordWorkKey === taskA.binding.recordWorkKey)?.publicationClaim?.commitId, taskA.commitId);
}

async function testMetadataSnapshotTamperCannotReachVerified(): Promise<void> {
    const fixture = await setup("metadata-snapshot", {
        recordMeta: { title: "original title", timeSpan: "2034", totalRounds: 3, totalSteps: 9, lastUpdatedRound: 3, lastUpdatedAt: timestamp, phases: 1, tags: ["stable"], chain: "codex" },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    const createdLedger = await protocol.read(fixture.commitId);
    assert.ok(createdLedger.payload.mainIndexMetadata, "adapter 必须在持久 protocol payload 前注入完整 metadata snapshot/hash");
    for (let step = 0; step < 4; step += 1) {
        assert.equal((await protocol.advanceOnce(fixture.commitId)).kind, "advanced");
    }
    const narrow = await recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget);
    assert.deepEqual(narrow.value, fixture.payload.mainIndexEntry, "篡改前窄 commitArtifact 仍只是 payload 的简化镜像");
    assert.equal(narrow.identity?.recordIndexMetadataHash, createdLedger.payload.mainIndexMetadata.hash, "artifact identity 必须绑定同一 payload metadata hash");
    assert.deepEqual(narrow.identity?.recordIndexMetadata, createdLedger.payload.mainIndexMetadata.snapshot, "artifact identity 与 payload metadata snapshot 必须完全一致");
    const index = await recordStore.readRecordsIndexAsync(fixture.recordStoreHash);
    index.records[fixture.binding.conversationId].title = "tampered title after main index write";
    await recordStore.writeRecordsIndex(fixture.recordStoreHash, index);
    const repaired = await protocol.recover(fixture.commitId);
    assert.equal(repaired.kind, "repair_required", "主索引 storage value 的 metadata 被篡改后绝不能误进 Verified");
    if (repaired.kind === "repair_required") assert.match(repaired.ledger.repairState || "", /main_index_full_storage_metadata_mismatch/u);
}

async function testPersistedMetadataSurvivesRestartBeforePublicationClaim(): Promise<void> {
    const firstPublicationToken = "first-publication-token-metadata-before-claim";
    const fixture = await setup("metadata-before-claim", {
        firstPublicationToken,
        recordMeta: { title: "persisted payload metadata", tags: ["payload", "metadata"] },
    });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    const created = await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    const beforeRestart = await registry.readRecordWorkRegistry({ identity: fixture.identity, dataRoot });
    assert.equal(beforeRestart.kind, "ready");
    if (beforeRestart.kind !== "ready") throw new Error("metadata-before-claim registry unavailable");
    assert.equal(beforeRestart.registry.works.find(work => work.recordWorkKey === fixture.binding.recordWorkKey)?.publicationClaim, undefined);

    const persisted = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true, nowMs: fixture.clock.nowMs() + 1_000 });
    assert.equal(persisted.kind, "current");
    if (persisted.kind !== "current" || !persisted.ledger.schedulerOwner) throw new Error("metadata-before-claim scheduler owner unavailable");
    const restartedClock = new Clock(fixture.clock.nowMs() + 1_000);
    const restarted = await adapterModule.createRecordCommitStorageAdapter({
        taskId: fixture.taskId,
        work: {
            identity: fixture.identity,
            desiredRevision: fixture.desiredRevision,
            firstPublicationToken,
            leaseDurationMs: 120_000,
        },
        paths: { dataRoot, recordStoreHash: fixture.recordStoreHash },
        clock: restartedClock,
        schedulerOwnerLease: persisted.ledger.schedulerOwner,
        spool: fixture.spool,
        recordMeta: { title: "restart metadata must not replace payload", tags: ["restart"] },
    });
    const restartedProtocol = new protocolModule.RecordCommitProtocol(restarted);
    const recovered = await restartedProtocol.recover(fixture.commitId);
    assert.equal(recovered.kind, "verified", "ledger-created but claim-missing restart must reuse the persisted metadata snapshot");

    const stored = await restartedProtocol.read(fixture.commitId);
    assert.deepEqual(stored.payload.mainIndexMetadata, created.payload.mainIndexMetadata);
    const afterRestart = await registry.readRecordWorkRegistry({ identity: fixture.identity, dataRoot });
    assert.equal(afterRestart.kind, "ready");
    if (afterRestart.kind !== "ready") throw new Error("metadata-before-claim registry disappeared");
    const claim = afterRestart.registry.works.find(work => work.recordWorkKey === fixture.binding.recordWorkKey)?.publicationClaim;
    assert.equal(claim?.metadataHash, created.payload.mainIndexMetadata.hash);
    assert.deepEqual(claim?.metadataSnapshot, created.payload.mainIndexMetadata.snapshot);
    const main = await recordStore.readRecordCommitMainIndexArtifact(fixture.recordStoreHash, fixture.payload.mainIndexTarget);
    assert.equal(main.identity?.recordIndexMetadataHash, created.payload.mainIndexMetadata.hash);
    assert.deepEqual(main.identity?.recordIndexMetadata, created.payload.mainIndexMetadata.snapshot);
}

async function testReadyRegistryRejectsWrongFirstPublicationToken(): Promise<void> {
    const identity = { chain: "codex" as const, workspaceHash: "token-ready-workspace", conversationId: "token-ready-conversation" };
    const firstPublicationToken = "first-publication-token-ready-registry";
    await setup("token-ready-owner", {
        taskId: "task-token-ready-owner",
        identity,
        firstPublicationToken,
        recordStoreHash: "records-token-ready",
    });
    await assert.rejects(
        () => setup("token-ready-wrong", {
            taskId: "task-token-ready-wrong",
            identity,
            firstPublicationToken: "wrong-first-publication-token-ready-registry",
            recordStoreHash: "records-token-ready",
            clockStart: nowMs + 100,
        }),
        /initialize_registry 失败: publication_rejected \(token_mismatch\)/u,
        "registry 已 ready 时 adapter 仍必须校验 firstPublicationToken，错误 token 要 fail closed",
    );
}

async function testForceRefreshReacquiresLeaseAfterArtifactLockWait(): Promise<void> {
    const identity = { chain: "codex" as const, workspaceHash: "force-refresh-lock-wait-workspace", conversationId: "force-refresh-lock-wait-conversation" };
    const desiredRevision = "revision-1";
    const firstPublicationToken = "first-publication-force-refresh-lock-wait";
    const recordStoreHash = "records-force-refresh-lock-wait";
    const previous = await setup("force-refresh-lock-wait-previous", {
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        body: "# previous winner\n\nbody-A",
        workLeaseDurationMs: 20,
    });
    const previousProtocol = new protocolModule.RecordCommitProtocol(previous.adapter);
    await previousProtocol.create({ commitId: previous.commitId, binding: previous.binding, payload: previous.payload });
    assert.equal((await previousProtocol.recover(previous.commitId)).kind, "verified");

    const refresh = await setup("force-refresh-lock-wait-next", {
        identity,
        desiredRevision,
        firstPublicationToken,
        recordStoreHash,
        body: "# refreshed winner\n\nbody-B",
        clockStart: nowMs + 100,
        workLeaseDurationMs: 20,
    });
    let nowReadCount = 0;
    const reconciled = await adapterModule.reconcileRecordWorkPublicationGeneration({
        taskId: refresh.taskId,
        recordWorkKey: refresh.binding.recordWorkKey,
        identity,
        dataRoot,
        recordStoreHash,
        schedulerOwnerLease: refresh.schedulerOwnerLease,
        leaseDurationMs: 20,
        nowMsProvider: () => {
            nowReadCount += 1;
            if (nowReadCount === 1) refresh.clock.advance(21);
            return refresh.clock.nowMs();
        },
    });
    assert.equal(reconciled.kind, "rolled_over", "artifact lock wait 跨过 lease 后应先续租，再推进 force refresh 代际");
    assert.ok(nowReadCount >= 3, "过期检测、续租和重试后的 rollover 都必须重新读取时钟");
    assert.ok(Date.parse(reconciled.lease.expiresAt) > refresh.clock.nowMs(), "rollover 返回的 lease 必须在当前时钟之后有效");
    const history = reconciled.work.publicationHistory?.at(-1);
    assert.equal(history?.reason, "visible_artifacts_diverged");
    assert.equal(history?.rolloverTrigger, "force_refresh");
}

async function testCorruptionRequiresRepair(): Promise<void> {
    const spoolFixture = await setup("spool-corruption");
    const spoolProtocol = new protocolModule.RecordCommitProtocol(spoolFixture.adapter);
    await spoolProtocol.create({ commitId: spoolFixture.commitId, binding: spoolFixture.binding, payload: spoolFixture.payload });
    fs.writeFileSync(path.join(dataRoot, spoolFixture.payload.bodyRef.relativePath), "corrupted", "utf8");
    const spoolResult = await spoolProtocol.recover(spoolFixture.commitId);
    assert.equal(spoolResult.kind, "repair_required");

    const registryFixture = await setup("registry-corruption");
    const registryProtocol = new protocolModule.RecordCommitProtocol(registryFixture.adapter);
    await registryProtocol.create({ commitId: registryFixture.commitId, binding: registryFixture.binding, payload: registryFixture.payload });
    const registryPath = registry.recordWorkRegistryPath({
        identity: { chain: "codex", workspaceHash: "workspace-registry-corruption", conversationId: "conversation-registry-corruption" },
        dataRoot,
    });
    fs.writeFileSync(registryPath, "{not-json", "utf8");
    const registryResult = await registryProtocol.advanceOnce(registryFixture.commitId);
    assert.equal(registryResult.kind, "repair_required");

    const ledgerFixture = await setup("ledger-corruption");
    const ledgerProtocol = new protocolModule.RecordCommitProtocol(ledgerFixture.adapter);
    await ledgerProtocol.create({ commitId: ledgerFixture.commitId, binding: ledgerFixture.binding, payload: ledgerFixture.payload });
    fs.writeFileSync(schedulerStore.recordSchedulerLedgerPath(ledgerFixture.taskId), "{not-json", "utf8");
    await assert.rejects(() => ledgerProtocol.read(ledgerFixture.commitId), /ledger_invalid_or_hash_mismatch/u);
}

async function runHardExitChild(): Promise<never> {
    const fixture = await setup("hard-child", { clockStart: hardExitNowMs });
    postFakeProvider();
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId: fixture.commitId, binding: fixture.binding, payload: fixture.payload });
    (fixture.adapter as unknown as { hooks?: { onFaultPoint: (input: { stage: string; point: string }) => void } }).hooks = {
        onFaultPoint: input => {
            if (input.stage === "BodyPublished" && input.point === "after_write") process.exit(86);
        },
    };
    await protocol.recover(fixture.commitId);
    throw new Error("hard-exit child did not terminate");
}

async function testHardExitRestartRecovery(): Promise<void> {
    const tsxCli = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawnSync(process.execPath, [tsxCli, path.resolve(process.argv[1]), "--hard-exit-child", dataRoot], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 120_000,
        env: { ...process.env, MEMORY_STORE_DATA_ROOT: dataRoot },
    });
    assert.equal(child.status, 86, `child stderr: ${child.stderr}`);
    assert.equal(fs.readFileSync(path.join(dataRoot, "fake-provider-post-count.txt"), "utf8"), "1");

    const taskId = "task-hard-child";
    const identity = { chain: "codex" as const, workspaceHash: "workspace-hard-child", conversationId: "conversation-hard-child" };
    const restartedClock = new Clock(hardExitNowMs + 1_000);
    const persisted = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs: restartedClock.nowMs() });
    assert.equal(persisted.kind, "current");
    if (persisted.kind !== "current" || !persisted.ledger.schedulerOwner) throw new Error("hard-exit owner lease was not durable");
    const restarted = await adapterModule.createRecordCommitStorageAdapter({
        taskId,
        work: { identity, desiredRevision: "revision-1", firstPublicationToken: "first-publication-hard-child", leaseDurationMs: 120_000 },
        paths: { dataRoot, recordStoreHash: "records-hard-child" },
        clock: restartedClock,
        schedulerOwnerLease: persisted.ledger.schedulerOwner,
    });
    const protocol = new protocolModule.RecordCommitProtocol(restarted);
    let recoveryCallbackCount = 0;
    const recovered = await restarted.recoverFromSchedulerLedger({
        recoverCommit: async commitId => {
            recoveryCallbackCount += 1;
            return protocol.recover(commitId);
        },
        dispatchProvider: async () => {
            postFakeProvider();
            return "unexpected provider dispatch during scheduler recovery";
        },
    });
    assert.deepEqual(recovered.map(item => ({ commitId: item.commitId, kind: item.result.kind })), [{ commitId: "commit-hard-child", kind: "verified" }]);
    assert.equal(recoveryCallbackCount, 1);
    assert.equal(fs.readFileSync(path.join(dataRoot, "fake-provider-post-count.txt"), "utf8"), "1", "scheduler-ledger recovery callback 不得触发 fake dispatcher");
}

try {
    if (hardExitChild) await runHardExitChild();
    if (!hardExitOnly) {
        await testAtomicCreateCancellationRaces();
        await testDualSchedulerAndProtocolCas();
        await testNormalCommit();
        await testCommitAuthorityBlocksExpiredLeaseTakeover();
        await testPublishTakeoverLockOrderCompletesWithoutCycle();
        await testCleanupTakeoverLockOrderCompletesWithoutCycle();
        await testLostLeaseBeforeAuthorityScopeWritesNothing();
        await testReplacedBodyIsSpoolReferenceOnly();
        await testWriteBeforeAfterRecovery();
        await testDetachedExclusiveCleanup();
        await testSharedDetachPreservesArtifacts();
        await testHigherEpochTakeoverStopsOldCleanup();
        await testHigherEpochArtifactsSurviveCleanupRestart();
        await testPeerJoinsAfterDetachBeforeCleanup();
        await testLateResultIsolation();
        await testSameIdentityWinnerBlocksDifferentBodyAndReusesSameBody();
        await testMetadataSnapshotTamperCannotReachVerified();
        await testPersistedMetadataSurvivesRestartBeforePublicationClaim();
        await testReadyRegistryRejectsWrongFirstPublicationToken();
        await testForceRefreshReacquiresLeaseAfterArtifactLockWait();
        await testCorruptionRequiresRepair();
    }
    await testHardExitRestartRecovery();
    console.log("record commit storage adapter tests passed");
} finally {
    if (!hardExitChild) fs.rmSync(dataRoot, { recursive: true, force: true });
}
