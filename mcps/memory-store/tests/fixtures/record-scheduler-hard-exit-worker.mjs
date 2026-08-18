import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const [action, dataRootArgument, configArgument = "{}"] = process.argv.slice(2);
if (!action || !dataRootArgument) throw new Error("worker requires action and DATA_ROOT");

const dataRoot = path.resolve(dataRootArgument);
const config = JSON.parse(configArgument);
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;

const [
    contracts,
    schedulerStore,
    schedulerSpool,
    registry,
    protocolModule,
    adapterModule,
    recordStore,
    readerStore,
] = await Promise.all([
    import("../../src/record-scheduler-contracts.ts"),
    import("../../src/record-scheduler-store.ts"),
    import("../../src/record-scheduler-spool.ts"),
    import("../../src/record-work-registry.ts"),
    import("../../src/record-commit-protocol.ts"),
    import("../../src/record-commit-storage-adapter.ts"),
    import("../../src/record-store.ts"),
    import("../../src/record-update-coordination.ts"),
]);

const label = "hard-exit-matrix";
const taskId = `task-${label}`;
const commitId = `commit-${label}`;
const workspaceHash = `workspace-${label}`;
const recordStoreHash = workspaceHash;
const desiredRevision = "revision-1";
const timestamp = "2034-01-02T03:04:05.000Z";
const nowMs = Date.parse(timestamp);
const sourceContent = "source hard-exit matrix";
const recordBody = "# hard-exit matrix\n\n正文只能通过 immutable output spool 恢复";
const identity = {
    chain: "codex",
    workspaceHash,
    conversationId: `conversation-${label}`,
};

class Clock {
    constructor(value = nowMs) {
        this.value = value;
    }

    now() {
        return new Date(this.value).toISOString();
    }

    nowMs() {
        return this.value;
    }
}

function sha256(value) {
    return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function syntheticReceiptLogPath() {
    return path.join(dataRoot, "adapter-synthetic-provider-receipts.json");
}

function readSyntheticReceiptLog() {
    if (!fs.existsSync(syntheticReceiptLogPath())) return { receipts: [] };
    return JSON.parse(fs.readFileSync(syntheticReceiptLogPath(), "utf8"));
}

function createSyntheticProviderReceipt() {
    const attemptId = `${taskId}-attempt`;
    const idempotencyKey = `record-attempt:${attemptId}:record-commit-epoch:1`;
    const log = readSyntheticReceiptLog();
    assert.equal(log.receipts.some(receipt => receipt.idempotencyKey === idempotencyKey), false, "adapter synthetic receipt 不得重复创建");
    log.receipts.push({ attemptId, idempotencyKey, body: recordBody });
    fs.writeFileSync(syntheticReceiptLogPath(), JSON.stringify(log), "utf8");
    return log.receipts.at(-1);
}

function readSyntheticProviderReceipt() {
    const log = readSyntheticReceiptLog();
    assert.equal(log.receipts.length, 1, "adapter 恢复前必须恰好只有一份 synthetic provider receipt");
    assert.equal(log.receipts[0]?.attemptId, `${taskId}-attempt`);
    assert.equal(log.receipts[0]?.body, recordBody);
    return log.receipts[0];
}

function createSpool(outputFault) {
    return schedulerSpool.createRecordSchedulerSpool({
        dataRoot,
        ...(outputFault ? {
            faultInjector: event => {
                if (event.operation === "write" && event.kind === "output" && event.point === outputFault.point) {
                    process.exit(outputFault.exitCode);
                }
            },
        } : {}),
    });
}

function makeInitialLedger({ recordWorkKey, sourceRef, outputRef }) {
    const sourceId = `${taskId}-source`;
    const unitId = `${taskId}-unit`;
    const attemptId = `${taskId}-attempt`;
    return {
        schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
        kind: "record-scheduler-ledger",
        revision: 1,
        persistedHash: "",
        task: {
            taskId,
            schedulerEpoch: 1,
            state: "Running",
            requestMode: "batch_update",
            candidateSnapshotId: `${taskId}-candidate`,
            candidateSnapshotRevision: 1,
            admissionIdentity: { requestKey: `${taskId}-request`, requestHash: sha256(`${taskId}-request`) },
            admission: { state: "LedgerCreated" },
            createdAt: timestamp,
            updatedAt: timestamp,
            repairState: "None",
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
            requestMode: "normal",
            filters: {},
            enumerations: [{ chain: "codex", complete: true, paginationExhausted: true, truncated: false }],
            candidates: [{
                conversationId: identity.conversationId,
                chain: identity.chain,
                workspaceHash: identity.workspaceHash,
                state: "Missing",
                evidence: ["hard-exit-matrix"],
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
            formatterVersion: "hard-exit-matrix",
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
            state: "Running",
            layer: "record",
            splitDepth: 0,
            recordWorkKey,
            recordCommitEpoch: 1,
            dependencies: [],
            composeOrder: 0,
            sourceSnapshotId: sourceId,
            inputHash: `${taskId}-input`,
            estimatedCost: 1,
            routePlan: ["grok"],
            attemptedProviders: ["grok"],
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
            state: "DispatchIntentPersisted",
            provider: "grok",
            model: "grok-4.5",
            dispatchIntentAt: timestamp,
            dispatchIntentLedgerRevision: 1,
            dispatchIntentRef: { path: `record-recovery/${taskId}/attempt.json`, hash: `${taskId}-attempt-intent`, byteLength: 1 },
            inputHash: `${taskId}-input`,
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

async function createAdapter({ clock, schedulerOwnerLease, spool, hooks }) {
    return adapterModule.createRecordCommitStorageAdapter({
        taskId,
        work: {
            identity,
            desiredRevision,
            firstPublicationToken: `first-publication-${label}`,
            leaseDurationMs: 120_000,
        },
        paths: { dataRoot, recordStoreHash },
        clock,
        schedulerOwnerLease,
        spool,
        hooks,
    });
}

async function createCommitFixture({ spool, sourceRef, outputRef, hooks }) {
    const clock = new Clock();
    const recordWorkKey = registry.recordWorkKey(identity, desiredRevision);
    const initial = makeInitialLedger({ recordWorkKey, sourceRef, outputRef });
    initial.persistedHash = schedulerStore.calculateRecordSchedulerLedgerHash(initial);
    const created = await schedulerStore.createRecordSchedulerLedger(initial);
    const ready = await schedulerStore.mutateRecordSchedulerLedger(taskId, created.revision, ledger => {
        ledger.units[0].state = "ResultReady";
        ledger.task.units.running = 0;
        ledger.attempts[0].state = "KnownSuccess";
        ledger.attempts[0].outcome = "known_success";
        ledger.attempts[0].startedAt = timestamp;
        ledger.attempts[0].leaseExpiresAt = new Date(nowMs + 60_000).toISOString();
        ledger.attempts[0].outputRef = outputRef;
    });
    const claimed = await schedulerStore.claimSchedulerOwnerLease(taskId, ready.revision, `owner-${label}`, { nowMs: clock.nowMs(), leaseMs: 120_000 });
    const adapter = await createAdapter({ clock, schedulerOwnerLease: claimed.ownerLease, spool, hooks });
    const current = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs: clock.nowMs() });
    assert.equal(current.kind, "current", "创建 commit fixture 后 scheduler ledger 必须可从磁盘读取");
    if (current.kind !== "current") throw new Error("scheduler ledger unavailable after fixture creation");
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
        contentHash: outputRef.hash,
        sourceSnapshotId: unit.sourceSnapshotId,
        inputHash: unit.inputHash,
    };
    const bodyRef = {
        kind: "immutable_record_body",
        conversationId: binding.conversationId,
        recordId: binding.recordId,
        objectId: `${outputRef.hash}:${outputRef.byteLength}`,
        relativePath: outputRef.path,
    };
    const payload = {
        bodyRef,
        bodyHash: outputRef.hash,
        byteLength: outputRef.byteLength,
        coveredRevision: desiredRevision,
        bodyTarget: {
            kind: "record_body",
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("record_body", binding.conversationId),
        },
        mainIndexTarget: {
            kind: "main_index",
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("main_index", binding.conversationId),
        },
        mainIndexEntry: { commitId, coveredRevision: desiredRevision, conversationId: binding.conversationId, recordId: binding.recordId },
        readerIndexTarget: {
            kind: "reader_index",
            conversationId: binding.conversationId,
            recordId: binding.recordId,
            relativePath: recordStore.getRecordCommitArtifactRelativePath("reader_index", binding.conversationId),
        },
        readerIndex: { commitId, bodyHash: outputRef.hash, coveredRevision: desiredRevision, conversationId: binding.conversationId, recordId: binding.recordId },
    };
    return { adapter, binding, clock, payload };
}

async function createInitialOutput({ outputFault } = {}) {
    const spool = createSpool(outputFault);
    await spool.initializeRoot({ mode: "create" });
    await spool.initializeTask({ taskId, mode: "create" });
    const source = await spool.writeImmutable({ taskId, kind: "source", content: sourceContent });
    const receipt = createSyntheticProviderReceipt();
    const output = await spool.writeImmutable({ taskId, kind: "output", content: receipt.body });
    return { spool, sourceRef: source.reference, outputRef: output.reference, outputDisposition: output.disposition };
}

async function reopenCommitAdapter() {
    const clock = new Clock(nowMs + 1_000);
    const spool = createSpool();
    await spool.initializeRoot({ mode: "open" });
    await spool.initializeTask({ taskId, mode: "open" });
    const persisted = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs: clock.nowMs() });
    assert.equal(persisted.kind, "current", "恢复进程只能从磁盘读取 scheduler ledger");
    if (persisted.kind !== "current" || !persisted.ledger.schedulerOwner) throw new Error("durable scheduler owner lease unavailable");
    const adapter = await createAdapter({ clock, schedulerOwnerLease: persisted.ledger.schedulerOwner, spool });
    return { adapter, clock, spool };
}

async function verifyCommittedState(protocol) {
    const ledger = await protocol.read(commitId);
    assert.equal(ledger.stage, "Verified");
    assert.equal(ledger.payload.coveredRevision, desiredRevision);
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(recordStoreHash, ledger.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, ledger.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, ledger.payload.readerIndexTarget),
    ]);
    assert.equal(body.body, recordBody, "恢复后的正文必须来自 immutable output spool");
    assert.equal(body.ownerCommitId, commitId);
    assert.deepEqual(main.value, ledger.payload.mainIndexEntry);
    assert.equal(main.ownerCommitId, commitId);
    assert.deepEqual(reader.value, ledger.payload.readerIndex);
    assert.equal(reader.ownerCommitId, commitId);
    const scheduler = await schedulerStore.readRecordSchedulerLedgerStore(taskId, { expectPublished: true, nowMs: nowMs + 1_000 });
    assert.equal(scheduler.kind, "current");
    if (scheduler.kind !== "current") throw new Error("verified scheduler ledger unavailable");
    const snapshot = scheduler.ledger.commits.find(commit => commit.commitId === commitId);
    assert.equal(snapshot?.state, "Verified");
    assert.equal(snapshot?.coveredRevision, desiredRevision);
    assert.equal(snapshot?.readBack?.mainIndexRevision, desiredRevision);
    assert.equal(snapshot?.readBack?.readerIndexRevision, desiredRevision);
    const synthetic = readSyntheticReceiptLog();
    assert.equal(synthetic.receipts.length, 1, "adapter 子矩阵只能保留一份 synthetic provider receipt");
    assert.equal(new Set(synthetic.receipts.map(receipt => receipt.idempotencyKey)).size, 1);
    return {
        commit: { stage: ledger.stage, coveredRevision: ledger.payload.coveredRevision },
        body: { ownerCommitId: body.ownerCommitId, content: body.body },
        mainIndex: main.value,
        readerIndex: reader.value,
        syntheticReceipt: { receiptCount: synthetic.receipts.length, idempotencyKeys: synthetic.receipts.map(receipt => receipt.idempotencyKey) },
    };
}

async function recoverExistingCommit() {
    const { adapter } = await reopenCommitAdapter();
    const protocol = new protocolModule.RecordCommitProtocol(adapter);
    let dispatchProviderCalls = 0;
    const recovered = await adapter.recoverFromSchedulerLedger({
        recoverCommit: currentCommitId => protocol.recover(currentCommitId),
        dispatchProvider: async () => {
            dispatchProviderCalls += 1;
            throw new Error("adapter 恢复已有 KnownSuccess output 时不得伪造第二份 provider receipt");
        },
    });
    assert.deepEqual(recovered.map(item => ({ commitId: item.commitId, kind: item.result.kind })), [{ commitId, kind: "verified" }]);
    assert.equal(dispatchProviderCalls, 0);
    const retry = await protocol.recover(commitId);
    assert.equal(retry.kind, "verified", "本地 commit 重试必须幂等");
    return verifyCommittedState(protocol);
}

async function crashDuringOutputSpool() {
    await createInitialOutput({ outputFault: config.outputFault });
    throw new Error("output spool fault hook did not hard-exit");
}

async function recoverAfterOutputSpoolCrash() {
    const spool = createSpool();
    await spool.initializeRoot({ mode: "open" });
    await spool.initializeTask({ taskId, mode: "open" });
    const source = await spool.writeImmutable({ taskId, kind: "source", content: sourceContent });
    const receipt = readSyntheticProviderReceipt();
    const output = await spool.writeImmutable({ taskId, kind: "output", content: receipt.body });
    const fixture = await createCommitFixture({ spool, sourceRef: source.reference, outputRef: output.reference });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId, binding: fixture.binding, payload: fixture.payload });
    const result = await protocol.recover(commitId);
    assert.equal(result.kind, "verified");
    return { outputDisposition: output.disposition, ...(await verifyCommittedState(protocol)) };
}

async function crashDuringCommit() {
    const output = await createInitialOutput();
    const hooks = {
        onFaultPoint: event => {
            if (event.stage === config.commitFault.stage && event.point === config.commitFault.point) {
                process.exit(config.commitFault.exitCode);
            }
        },
    };
    const fixture = await createCommitFixture({ ...output, hooks });
    const protocol = new protocolModule.RecordCommitProtocol(fixture.adapter);
    await protocol.create({ commitId, binding: fixture.binding, payload: fixture.payload });
    await protocol.recover(commitId);
    throw new Error(`commit fault hook did not hard-exit at ${config.commitFault.stage}/${config.commitFault.point}`);
}

async function writeHigherEpochArtifacts(payload, recordCommitEpoch) {
    const successorCommitId = `${commitId}-higher-epoch`;
    const body = "# higher epoch record\n\n旧 epoch 不得覆盖这份正文";
    const bodyHash = sha256(body);
    const coveredRevision = "revision-2";
    const artifactIdentity = {
        conversationId: payload.bodyTarget.conversationId,
        recordId: payload.bodyTarget.recordId,
        commitId: successorCommitId,
        coveredRevision,
        bodyHash,
        recordCommitEpoch,
    };
    const currentBody = await recordStore.readRecordCommitBodyArtifact(recordStoreHash, payload.bodyTarget);
    const bodyWrite = await recordStore.writeRecordCommitBodyConditionally({
        hash: recordStoreHash,
        target: payload.bodyTarget,
        identity: artifactIdentity,
        body,
        expected: currentBody,
        validateOwnership: async () => true,
    });
    assert.equal(bodyWrite.kind, "applied");
    const mainIndexEntry = {
        commitId: successorCommitId,
        coveredRevision,
        conversationId: payload.mainIndexTarget.conversationId,
        recordId: payload.mainIndexTarget.recordId,
    };
    const currentMain = await recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, payload.mainIndexTarget);
    const mainWrite = await recordStore.writeRecordCommitMainIndexConditionally({
        hash: recordStoreHash,
        target: payload.mainIndexTarget,
        identity: artifactIdentity,
        entry: mainIndexEntry,
        expected: currentMain,
        validateOwnership: async () => true,
    });
    assert.equal(mainWrite.kind, "applied");
    const readerIndex = { ...mainIndexEntry, bodyHash };
    const currentReader = await readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, payload.readerIndexTarget);
    const readerWrite = await readerStore.writeRecordCommitReaderIndexConditionally({
        hash: recordStoreHash,
        target: payload.readerIndexTarget,
        identity: artifactIdentity,
        index: readerIndex,
        expected: currentReader,
        validateOwnership: async () => true,
    });
    assert.equal(readerWrite.kind, "applied");
    return { successorCommitId, body, coveredRevision, mainIndexEntry, readerIndex };
}

async function verifyHigherEpochBlocksOldRecovery() {
    const { adapter, clock } = await reopenCommitAdapter();
    const protocol = new protocolModule.RecordCommitProtocol(adapter);
    const oldLedger = await protocol.read(commitId);
    const location = { identity, dataRoot };
    const beforeTakeover = await registry.readRecordWorkRegistry(location);
    assert.equal(beforeTakeover.kind, "ready");
    if (beforeTakeover.kind !== "ready") throw new Error("registry unavailable before higher epoch takeover");
    const successor = await registry.startOrAttachRecordWork({
        ...location,
        desiredRevision: "revision-2",
        taskId: `${taskId}-successor`,
        expectedRegistryRevision: beforeTakeover.registry.registryRevision,
        nowMs: clock.nowMs(),
    });
    assert.equal(successor.kind, "started");
    if (successor.kind !== "started") throw new Error("higher epoch record work was not created");
    const successorLease = await registry.acquireRecordWorkLease({
        ...location,
        recordWorkKey: successor.work.recordWorkKey,
        taskId: `${taskId}-successor`,
        ownerId: `owner-${label}-successor`,
        schedulerEpoch: 2,
        expectedRegistryRevision: successor.registry.registryRevision,
        workLeaseId: `${taskId}-successor-lease`,
        leaseDurationMs: 120_000,
        nowMs: clock.nowMs(),
    });
    assert.equal(successorLease.kind, "acquired");
    if (successorLease.kind !== "acquired") throw new Error("higher epoch record work lease was not acquired");
    assert.ok(successorLease.work.recordCommitEpoch > oldLedger.binding.recordCommitEpoch);
    const higher = await writeHigherEpochArtifacts(oldLedger.payload, successorLease.work.recordCommitEpoch);
    const oldRecovery = await protocol.recover(commitId);
    assert.equal(oldRecovery.kind, "audited_stale", "旧 epoch 的恢复不得写回更高 epoch 的 artifacts");
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact(recordStoreHash, oldLedger.payload.bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact(recordStoreHash, oldLedger.payload.mainIndexTarget),
        readerStore.readRecordCommitReaderIndexArtifact(recordStoreHash, oldLedger.payload.readerIndexTarget),
    ]);
    assert.equal(body.body, higher.body);
    assert.equal(body.ownerCommitId, higher.successorCommitId);
    assert.deepEqual(main.value, higher.mainIndexEntry);
    assert.equal(main.ownerCommitId, higher.successorCommitId);
    assert.deepEqual(reader.value, higher.readerIndex);
    assert.equal(reader.ownerCommitId, higher.successorCommitId);
    const synthetic = readSyntheticReceiptLog();
    assert.equal(synthetic.receipts.length, 1);
    return {
        oldRecovery: oldRecovery.kind,
        higherEpoch: successorLease.work.recordCommitEpoch,
        bodyOwner: body.ownerCommitId,
        mainOwner: main.ownerCommitId,
        readerOwner: reader.ownerCommitId,
        syntheticReceiptCount: synthetic.receipts.length,
    };
}

function productionSource(requestIdentity) {
    return {
        host: "codex",
        identity: {
            workspace: {
                workspaceId: `hard-exit-${requestIdentity}`,
                canonicalPath: `C:/fixtures/hard-exit/${requestIdentity}`,
            },
            source: {
                kind: "filesystem",
                authority: `C:/fixtures/hard-exit/${requestIdentity}/authority`,
                authoritativeRoot: `C:/fixtures/hard-exit/${requestIdentity}/authority`,
                canonicalPath: `C:/fixtures/hard-exit/${requestIdentity}/store`,
            },
            conversationId: `conversation-${requestIdentity}`,
        },
    };
}

function productionDiscoveryInput(source, discovery, evidence) {
    const observedAt = "2026-07-14T00:00:00.000Z";
    const enumeration = evidence.buildSourceEnumerationEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: source.host,
        identity: source.identity,
        sourceRevision: { revision: "rev-2", contentCursor: "cursor-2", eventWatermark: "event-2", sequence: 2 },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: { scanId: `scan-${source.identity.conversationId}`, sequence: 2, startedAt: observedAt, completedAt: observedAt },
        targetStatus: "present",
    });
    const scope = discovery.buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `index-${source.identity.conversationId}`,
        indexRevision: "index-revision-1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
    const entry = discovery.buildRecordIndexEntry({
        recordId: `record-${source.identity.conversationId}`,
        source,
        indexSnapshotId: scope.snapshotId,
        indexRevision: scope.indexRevision,
        coveredRevision: { revision: "rev-1", sequence: 1 },
        recordBodyHash: `sha256:${sha256(source.identity.conversationId)}`,
        extensions: {},
    });
    return {
        request: {
            snapshotId: `snapshot-${source.identity.conversationId}`,
            discoveredAtSequence: 2,
            filters: { hosts: [], workspace: null, extensions: {} },
        },
        sourceEnumerations: [{ evidence: enumeration, revisionSequence: 2, title: source.identity.conversationId }],
        recordIndex: { scopes: [scope], entries: [entry] },
    };
}

function productionReader(source, evidence) {
    return {
        async scan(request) {
            assert.equal(request.host, source.host);
            assert.equal(request.conversationId, source.identity.conversationId);
            const observedAt = "2026-07-14T00:00:00.000Z";
            const document = {
                schemaVersion: "record-source-content/v1",
                formatterVersion: "canonical-json-nfc-lf/v1",
                source: { host: source.host, conversationId: source.identity.conversationId },
                messages: [
                    { order: 1, role: "user", content: source.identity.conversationId },
                    { order: 2, role: "assistant", content: "hard-exit production fixture" },
                ],
            };
            const bytes = Buffer.from(JSON.stringify(document), "utf8");
            const contentHash = `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
            const enumeration = evidence.buildSourceEnumerationEvidence({
                adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
                host: source.host,
                identity: source.identity,
                sourceRevision: { revision: "rev-2", contentCursor: "cursor-2", eventWatermark: "event-2", sequence: 2 },
                pagination: { cursor: null, pages: 1, limit: null, truncated: false },
                enumerationComplete: true,
                cacheBypassed: true,
                exactFetchResult: "present",
                errors: [],
                warnings: [],
                observedAt: { scanId: `scan-${source.identity.conversationId}`, sequence: 2, startedAt: observedAt, completedAt: observedAt },
                targetStatus: "present",
            });
            const exactFetch = evidence.buildExactFetchEvidence({
                adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
                host: source.host,
                identity: source.identity,
                sourceRevision: enumeration.sourceRevision,
                pagination: enumeration.pagination,
                enumerationComplete: true,
                cacheBypassed: true,
                exactFetchResult: "present",
                errors: [],
                warnings: [],
                observedAt: enumeration.observedAt,
            });
            const fullEvidence = evidence.buildFullSourceReadEvidence({
                adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
                host: source.host,
                identity: source.identity,
                sourceRevision: enumeration.sourceRevision,
                pagination: enumeration.pagination,
                enumerationComplete: true,
                cacheBypassed: true,
                exactFetchResult: "present",
                errors: [],
                warnings: [],
                observedAt: enumeration.observedAt,
                content: {
                    mode: "full",
                    byteLength: bytes.byteLength,
                    contentHash,
                    roundRange: { start: 1, end: 2 },
                    truncated: false,
                    staleCache: false,
                },
            });
            return {
                host: source.host,
                scanId: enumeration.observedAt.scanId,
                enumeration,
                exactFetch,
                fullSourceRead: {
                    status: "complete",
                    evidence: fullEvidence,
                    payload: {
                        schemaVersion: document.schemaVersion,
                        formatterVersion: document.formatterVersion,
                        mediaType: "application/vnd.memory-store.record-source+json",
                        encoding: "utf-8",
                        bytes,
                        byteLength: bytes.byteLength,
                        contentHash,
                    },
                    sourceSnapshot: null,
                    authority: {
                        identityHash: crypto.createHash("sha256").update(evidence.canonicalSerialize(source.identity)).digest("hex"),
                        revisionHash: crypto.createHash("sha256").update(enumeration.sourceRevision.revision).digest("hex"),
                        identityStable: true,
                        revisionStable: true,
                        cacheBypassed: true,
                        enumerationEvidenceHash: enumeration.evidenceHash,
                        exactFetchEvidenceHash: exactFetch.evidenceHash,
                        fullReadEvidenceHash: fullEvidence.evidenceHash,
                    },
                    issues: [],
                },
                sourceSnapshot: null,
                classification: { state: "Present", reason: "hard-exit-production-fixture" },
                qualifiedAbsence: null,
            };
        },
    };
}

function productionRequestSummary(requestIdentity, finalize, providerBehavior) {
    return {
        operation: "record-update",
        workspaceHash: `hard-exit-workspace-${requestIdentity}`,
        dataChain: "codex",
        modelChain: "grok",
        requestIdentity,
        finalize,
        providerBehavior,
    };
}

function productionResumePayload(requestIdentity, discoveryInput, finalize, providerBehavior) {
    return {
        kind: "record-update",
        executionDescriptor: {
            schemaVersion: 1,
            requestIdentity,
            requestMode: "normal",
            finalize,
            providerBehavior,
            discovery: { kind: "record-update", selector: "normal", input: discoveryInput },
        },
    };
}

function productionAdmissionRequest(runtimeModule, requestIdentity, discoveryInput, finalize, providerBehavior) {
    const requestSummary = productionRequestSummary(requestIdentity, finalize, providerBehavior);
    const resumePayload = productionResumePayload(requestIdentity, discoveryInput, finalize, providerBehavior);
    return {
        kind: "record-update",
        requestKey: runtimeModule.recordSchedulerRequestKey("record-update", requestSummary),
        requestSummary,
        resumePayload,
        requestMode: "normal",
        discovery: resumePayload.executionDescriptor.discovery,
        execute: async () => "hard-exit production worker must run through executeForTest or resumeExecution",
    };
}

function parsePersistedExecutionDescriptor(capsule) {
    const resumePayload = capsule?.backgroundProjection?.resumePayload;
    const descriptor = resumePayload?.executionDescriptor;
    if (!resumePayload || resumePayload.kind !== "record-update" || !descriptor || descriptor.schemaVersion !== 1) {
        throw new Error("persisted execution descriptor is missing or unsupported");
    }
    if (typeof descriptor.requestIdentity !== "string" || descriptor.requestIdentity.length === 0) {
        throw new Error("persisted execution descriptor requestIdentity is invalid");
    }
    if (descriptor.requestMode !== "normal"
        || typeof descriptor.finalize !== "boolean"
        || typeof descriptor.providerBehavior !== "string"
        || descriptor.discovery?.kind !== "record-update"
        || descriptor.discovery?.selector !== "normal"
        || !descriptor.discovery.input) {
        throw new Error("persisted execution descriptor shape is invalid");
    }
    return { resumePayload, descriptor };
}

function createProductionTransport(modules, ownerId, recovering) {
    const timeOffsetMs = recovering ? 60_000 : 0;
    const admission = modules.providerAdmissionModule.createProviderAdmission({
        mode: "test",
        dataRoot,
        ownerId,
        ownerLeaseDurationMs: 30_000,
        leaseDurationMs: 10_000,
        uncertainGraceMs: 25,
        now: () => Date.now() + timeOffsetMs,
    });
    return new modules.transportModule.ProviderTransportAdapter({ mode: "test", admission });
}

function createProductionCall(providerUrl, requestIdentity, providerBehavior, transport) {
    const invokePrompt = async (prompt, options) => {
        assert.equal(typeof options?.attemptId, "string", "production pump 必须把 attemptId 传给 provider invoke");
        assert.equal(typeof options?.idempotencyKey, "string", "production pump 必须把 idempotencyKey 传给 provider invoke");
        assert.ok(options?.transportLease, "production provider invoke 必须消费真实 ProviderAdmission lease");
        const invokeHttp = async () => {
            const response = await fetch(providerUrl, {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    "x-record-attempt-id": options.attemptId,
                    "idempotency-key": options.idempotencyKey,
                },
                body: JSON.stringify({ requestIdentity, providerBehavior, prompt }),
            });
            const responseText = await response.text();
            if (!response.ok) throw new Error(`fake provider returned ${response.status}: ${responseText}`);
            return JSON.parse(responseText);
        };
        return await transport.executeGranted(
            options.transportLease,
            invokeHttp,
            settled => settled.text === null ? "failure" : "success",
        );
    };
    const invoke = options => invokePrompt(requestIdentity, options);
    return {
        logicalCallKey: `hard-exit-model-call:${requestIdentity}`,
        provider: "grok",
        model: "fake-hard-exit-http",
        prompt: requestIdentity,
        logicalTimeout: 1_000,
        routePlan: ["grok"],
        providerCalls: [{
            provider: "grok",
            model: "fake-hard-exit-http",
            logicalTimeout: 1_000,
            invokeTimeout: 1_000,
            invoke,
            invokePrompt,
        }],
        recipe: {
            recipeVersion: 1,
            templateId: "hard-exit-production/v1",
            range: { axis: "round", start: 1, end: 1 },
            composeOrder: 0,
        },
        retryBudget: 1,
        splitPrompt: range => `${requestIdentity}\n\n[split ${range.axis} ${range.start}-${range.end}]`,
        invokeTimeout: 1_000,
        retryOrdinal: 0,
        trafficClass: "record-batch",
        context: { requestedChain: "grok", background: true, providerTrafficClass: "record", grokContext: "record" },
        invoke,
    };
}

function productionRegistration(taskIdValue, frozenSources, control, spool, requestIdentity, schedulerOwnerId) {
    const source = frozenSources.sources[0];
    assert.ok(source, "runtime 必须封存一个生产 source snapshot");
    return {
        taskId: taskIdValue,
        frozenSources,
        sourceSnapshotId: source.snapshot.sourceSnapshotId,
        recordStoreHash: source.snapshot.workspaceHash,
        schedulerOwner: {
            ownerId: schedulerOwnerId,
            leaseMs: 30_000,
            workLeaseMs: 30_000,
        },
        control,
        spool,
        firstPublicationToken: `hard-exit-first-publication-${requestIdentity}`,
    };
}

class ProductionClock {
    constructor(recovering) {
        this.offset = recovering ? 60_000 : 0;
    }

    nowMs() {
        return Date.now() + this.offset;
    }

    advance(milliseconds) {
        this.offset += milliseconds;
    }
}

async function loadProductionModules() {
    const [
        runtimeModule,
        controlModule,
        spoolModule,
        pumpModule,
        transportModule,
        providerAdmissionModule,
        providerControlStoreModule,
        discoveryModule,
        evidenceModule,
        schedulerStoreModule,
        coordinatorStoreModule,
    ] = await Promise.all([
        import("../../src/record-scheduler-runtime.ts"),
        import("../../src/record-scheduler-control.ts"),
        import("../../src/record-scheduler-spool.ts"),
        import("../../src/record-scheduler-production-pump.ts"),
        import("../../src/provider-transport-adapter.ts"),
        import("../../src/provider-admission.ts"),
        import("../../src/provider-control-store.ts"),
        import("../../src/record-discovery.ts"),
        import("../../src/source-evidence-contracts.ts"),
        import("../../src/record-scheduler-store.ts"),
        import("../../src/record-scheduler-coordinator-store.ts"),
    ]);
    return {
        runtimeModule,
        controlModule,
        spoolModule,
        pumpModule,
        transportModule,
        providerAdmissionModule,
        providerControlStoreModule,
        discoveryModule,
        evidenceModule,
        schedulerStoreModule,
        coordinatorStoreModule,
    };
}

async function readProviderOutputEvidence(taskIdValue, modules, spool, preferredAttemptId) {
    const stored = await modules.schedulerStoreModule.readRecordSchedulerLedgerStore(taskIdValue, { expectPublished: true });
    assert.equal(stored.kind, "current", "provider output evidence requires a current scheduler ledger");
    if (stored.kind !== "current") throw new Error(`provider output evidence unavailable: ${stored.kind}`);
    const candidates = stored.ledger.attempts.filter(attempt => attempt.managedByProductionPump === true
        && attempt.provider !== "local"
        && attempt.state === "KnownSuccess"
        && attempt.outputRef);
    const attempt = preferredAttemptId
        ? candidates.find(candidate => candidate.attemptId === preferredAttemptId)
        : candidates.at(-1);
    assert.ok(attempt?.outputRef, "provider result 必须由持久 KnownSuccess Attempt/outputRef 提供");
    const bytes = await spool.readImmutable({ taskId: taskIdValue, kind: "output", reference: attempt.outputRef });
    const computedHash = crypto.createHash("sha256").update(bytes).digest("hex");
    assert.equal(computedHash, attempt.outputRef.hash, "provider output spool hash 与 Attempt outputRef 不一致");
    assert.equal(bytes.byteLength, attempt.outputRef.byteLength, "provider output spool byteLength 与 Attempt outputRef 不一致");
    const result = JSON.parse(bytes.toString("utf8"));
    assert.equal(typeof result.text, "string", "provider output spool 缺少 HTTP response text");
    return { attempt, result };
}

function finalContentFromProviderOutput(evidence) {
    return [
        "# production hard-exit replay-bound commit",
        "",
        `provider-output-ref:${evidence.attempt.outputRef.hash}:${evidence.attempt.outputRef.byteLength}`,
        `provider-response-hash:${sha256(evidence.result.text)}`,
        "",
        evidence.result.text,
    ].join("\n");
}

function assertCommitPersistenceEvent(event, input) {
    const stages = ["BodyStaged", "PublishIntent", "BodyPublished", "MainIndexWritten", "ReaderIndexWritten", "Verified"];
    const ordinal = stages.indexOf(input.crash.stage);
    assert.notEqual(ordinal, -1, `unsupported commit persistence stage: ${input.crash.stage}`);
    const predecessorRevision = 1 + ordinal * 2;
    const confirming = input.crash.persistencePoint === "before_stage_confirm" || input.crash.persistencePoint === "after_stage_confirm";
    const expectedRevision = predecessorRevision + (confirming ? 1 : 0);
    assert.equal(event.stage, input.crash.stage);
    assert.equal(event.point, input.crash.persistencePoint);
    assert.equal(event.expectedRevision, expectedRevision, "commit persistence hook expectedRevision 不正确");
    assert.equal(event.nextRevision, expectedRevision + 1, "commit persistence hook nextRevision 不正确");
    assert.equal(event.binding.taskId, input.taskId, "commit persistence hook binding.taskId 不正确");
    assert.equal(typeof event.binding.attemptId, "string");
    assert.ok(event.binding.attemptId.length > 0);
}

const TEST_UNKNOWN_OUTCOME_GRACE_MS = 25;

async function executeProductionPath(input) {
    const clock = new ProductionClock(input.recovering);
    const transport = createProductionTransport(input.modules, `hard-exit-provider-owner-${input.requestIdentity}-${process.pid}`, input.recovering);
    const pump = new input.modules.pumpModule.RecordSchedulerProductionPump({
        coordinatorOwnerId: `hard-exit-coordinator-${input.requestIdentity}-${process.pid}`,
        coordinatorLeaseMs: 10_000,
        coordinatorStore: {
            dataRoot,
            testClock: input.modules.coordinatorStoreModule.createRecordSchedulerCoordinatorTestClockForTest(() => clock.nowMs()),
        },
        providerTransport: transport,
        unknownOutcomeGraceMs: TEST_UNKNOWN_OUTCOME_GRACE_MS,
        clock,
        onPhase: async event => {
            if (input.crash?.phase === event.phase) process.exit(input.crash.exitCode);
        },
    });
    try {
        const registration = productionRegistration(
            input.taskId,
            input.frozenSources,
            input.control,
            input.spool,
            input.requestIdentity,
            input.schedulerOwnerId,
        );
        const session = pump.createSession(registration);
        const call = createProductionCall(input.providerUrl, input.requestIdentity, input.providerBehavior, transport);
        let providerResult;
        for (let retry = 0; retry < 3; retry += 1) {
            try {
                providerResult = await session.schedulerModelCall(call);
                break;
            } catch (error) {
                if (error?.code !== "UNKNOWN_OUTCOME" || retry === 2) throw error;
                clock.advance(TEST_UNKNOWN_OUTCOME_GRACE_MS + 1);
            }
        }
        assert.ok(providerResult, "production schedulerModelCall 未返回结果");
        const providerEvidence = await readProviderOutputEvidence(input.taskId, input.modules, input.spool);
        assert.equal(providerResult.text, providerEvidence.result.text, "schedulerModelCall 返回值必须精确来自持久 output spool");
        let finalizeResult = null;
        if (input.finalize) {
            const hooks = input.crash?.stage ? {
                onPersistenceFaultPoint: event => {
                    if (event.stage === input.crash.stage && event.point === input.crash.persistencePoint) {
                        assertCommitPersistenceEvent(event, input);
                        process.exit(input.crash.exitCode);
                    }
                },
                onFaultPoint: event => {
                    if (event.stage === input.crash.stage && event.point === input.crash.effectPoint) process.exit(input.crash.exitCode);
                },
            } : undefined;
            finalizeResult = await session.finalizeLocalRecord({
                content: finalContentFromProviderOutput(providerEvidence),
                commit: {
                    firstPublicationToken: registration.firstPublicationToken,
                    ...(hooks ? { hooks } : {}),
                },
            });
        }
        return { providerResultText: providerResult.text, finalizeResult };
    } finally {
        await pump.close({ timeoutMs: 1_000 }).catch(() => undefined);
        await transport.close().catch(() => undefined);
    }
}

function recoveryContext(taskIdValue) {
    return {
        taskId: taskIdValue,
        updateProgress() {},
        isCancelled: () => false,
        isSettled: () => false,
    };
}

function scanSingleProductionTask(schedulerStoreModule) {
    const taskIds = schedulerStoreModule.listRecordSchedulerLedgerTaskIds();
    assert.deepEqual(taskIds.length, 1, `hard-exit dataRoot 必须恰有一个 scheduler task，实际=${JSON.stringify(taskIds)}`);
    return taskIds[0];
}

async function loadPersistedRecoveryDescriptor(modules, taskIdValue) {
    const verified = await modules.schedulerStoreModule.verifyOrRecoverTaskAdmission(taskIdValue);
    if (verified.kind !== "verified") {
        throw new modules.runtimeModule.RecordSchedulerRepairRequiredError(`persisted admission descriptor unavailable: ${verified.kind}:${verified.reason || "unknown"}`);
    }
    let parsed;
    try {
        parsed = parsePersistedExecutionDescriptor(verified.capsule);
    } catch (error) {
        throw new modules.runtimeModule.RecordSchedulerRepairRequiredError(error instanceof Error ? error.message : String(error));
    }
    return {
        metadata: parsed.descriptor,
        runtimeDescriptor: {
            kind: "record-update",
            requestKey: verified.capsule.admissionIdentity.requestKey,
            requestSummary: verified.capsule.requestSummary,
            resumePayload: verified.capsule.backgroundProjection.resumePayload,
            requestMode: parsed.descriptor.requestMode,
            ...(verified.capsule.backgroundProjection.projection === undefined ? {} : {
                backgroundProjection: verified.capsule.backgroundProjection.projection,
            }),
            discovery: parsed.descriptor.discovery,
        },
    };
}

async function readAttemptOutputSummary(spool, taskIdValue, attempt) {
    if (!attempt.outputRef) return null;
    try {
        const bytes = await spool.readImmutable({ taskId: taskIdValue, kind: "output", reference: attempt.outputRef });
        let providerResultText = null;
        try {
            const parsed = JSON.parse(bytes.toString("utf8"));
            providerResultText = typeof parsed.text === "string" ? parsed.text : null;
        } catch {
        }
        return {
            kind: "current",
            computedHash: crypto.createHash("sha256").update(bytes).digest("hex"),
            byteLength: bytes.byteLength,
            providerResultText,
        };
    } catch (error) {
        return { kind: "corrupt", error: error instanceof Error ? error.message : String(error) };
    }
}

async function inspectProductionState(modules) {
    const taskIdValue = scanSingleProductionTask(modules.schedulerStoreModule);
    const stored = await modules.schedulerStoreModule.readRecordSchedulerLedgerStore(taskIdValue, { expectPublished: true });
    assert.equal(stored.kind, "current", "production state inspection requires a current scheduler ledger");
    if (stored.kind !== "current") throw new Error(`production state unavailable: ${stored.kind}`);
    const spool = modules.spoolModule.createRecordSchedulerSpool({ dataRoot });
    await spool.initializeRoot({ mode: "open" });
    await spool.initializeTask({ taskId: taskIdValue, mode: "open" });
    const admissionRead = await modules.schedulerStoreModule.readRecordSchedulerAdmissionCapsule(taskIdValue);
    const attempts = await Promise.all(stored.ledger.attempts.map(async attempt => {
        let providerLease = null;
        if (attempt.provider === "grok" || attempt.provider === "agy") {
            providerLease = await modules.providerControlStoreModule.readProviderLeaseByAttempt({
                dataRoot,
                provider: attempt.provider,
                attemptId: attempt.attemptId,
            });
        }
        return {
            attemptId: attempt.attemptId,
            provider: attempt.provider,
            managedByProductionPump: attempt.managedByProductionPump === true,
            state: attempt.state,
            dispatchPhase: attempt.dispatchPhase || null,
            outcome: attempt.outcome || null,
            errorClass: attempt.errorClass || null,
            providerEvidence: attempt.providerEvidence || null,
            idempotencyKey: attempt.idempotencyKey || null,
            unknownOutcomeAt: attempt.unknownOutcomeAt || null,
            outputRef: attempt.outputRef || null,
            output: await readAttemptOutputSummary(spool, taskIdValue, attempt),
            providerLease,
            fence: attempt.fence ? {
                schedulerEpoch: attempt.fence.schedulerEpoch,
                recordCommitEpoch: attempt.fence.recordCommitEpoch,
                fencingToken: attempt.fence.fencingToken,
            } : null,
        };
    }));
    const recordStoreHashValue = stored.ledger.sourceSnapshots[0]?.workspaceHash;
    const commits = await Promise.all(stored.ledger.commits.map(async commit => {
        const protocol = commit.protocolLedger && typeof commit.protocolLedger === "object" ? commit.protocolLedger : null;
        let publishedBody = null;
        if (recordStoreHashValue && protocol?.payload?.bodyTarget) {
            const image = await recordStore.readRecordCommitBodyArtifact(recordStoreHashValue, protocol.payload.bodyTarget);
            publishedBody = { ownerCommitId: image.ownerCommitId, content: image.body };
        }
        return {
            commitId: commit.commitId,
            state: commit.state,
            protocol: protocol ? {
                revision: protocol.revision,
                stage: protocol.stage,
                intentTarget: protocol.intent?.targetStage || null,
                confirmedStages: protocol.confirmedStages,
                bodyHash: protocol.payload.bodyHash,
            } : null,
            publishedBody,
        };
    }));
    const resumePayload = admissionRead.kind === "current" ? admissionRead.capsule.backgroundProjection.resumePayload : undefined;
    return {
        taskId: taskIdValue,
        ledgerRevision: stored.ledger.revision,
        task: { state: stored.ledger.task.state, repairState: stored.ledger.task.repairState },
        admission: {
            kind: admissionRead.kind,
            resumePayloadPresent: resumePayload !== undefined,
            descriptorPresent: Boolean(resumePayload?.executionDescriptor),
        },
        attempts,
        commits,
    };
}

async function crashProduction(actionValue) {
    const modules = await loadProductionModules();
    const requestIdentity = config.requestIdentity;
    const providerUrl = config.providerUrl;
    const providerBehavior = typeof config.providerBehavior === "string" ? config.providerBehavior : "respond";
    assert.equal(typeof requestIdentity, "string");
    assert.equal(typeof providerUrl, "string");
    const finalize = actionValue === "crash-production-commit";
    const source = productionSource(requestIdentity);
    const discoveryInput = productionDiscoveryInput(source, modules.discoveryModule, modules.evidenceModule);
    const spool = modules.spoolModule.createRecordSchedulerSpool({ dataRoot });
    const control = modules.controlModule.createRecordSchedulerControl({ dataRoot, spool });
    const runtimeOwnerId = `hard-exit-runtime-owner-${requestIdentity}-${process.pid}`;
    const runtime = modules.runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: runtimeOwnerId,
        ownerLeaseMs: 30_000,
        control,
        sourceEvidenceAdapter: { buildDiscoveryInput: async () => discoveryInput },
        productionSourceReader: productionReader(source, modules.evidenceModule),
        executeForTest: async request => {
            assert.ok(request.sourceSnapshots, "runtime executeForTest 必须收到 sealed frozen sources");
            return JSON.stringify(await executeProductionPath({
                taskId: request.taskId,
                frozenSources: request.sourceSnapshots,
                control,
                spool,
                modules,
                providerUrl,
                requestIdentity,
                providerBehavior,
                crash: config.crash,
                finalize,
                recovering: false,
                schedulerOwnerId: runtimeOwnerId,
            }));
        },
    });
    const admissionRequest = productionAdmissionRequest(modules.runtimeModule, requestIdentity, discoveryInput, finalize, providerBehavior);
    const admission = await runtime.admit(admissionRequest);
    if (admission.outcome === "UnknownOutcome") {
        throw new Error(`production hard-exit admission outcome is unknown: ${JSON.stringify(admission)}`);
    }
    const backgroundTask = admission.admission.task;
    const deadline = Date.now() + 15_000;
    while (backgroundTask.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`production hard-exit hook did not call process.exit: ${JSON.stringify({ admission, backgroundTask })}`);
}

function stableJsonStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
    if (value && typeof value === "object") {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
}

async function tamperPersistedProductionState() {
    const modules = await loadProductionModules();
    const taskIdValue = scanSingleProductionTask(modules.schedulerStoreModule);
    const tamper = config.tamper;
    if (tamper === "descriptor-missing" || tamper === "descriptor-tampered") {
        const capsulePath = modules.schedulerStoreModule.recordSchedulerAdmissionCapsulePath(taskIdValue);
        const capsule = JSON.parse(fs.readFileSync(capsulePath, "utf8"));
        if (tamper === "descriptor-missing") delete capsule.backgroundProjection.resumePayload.executionDescriptor;
        else capsule.backgroundProjection.resumePayload.executionDescriptor.requestIdentity = "forged-request-identity";
        fs.writeFileSync(capsulePath, stableJsonStringify(capsule), "utf8");
        return { taskId: taskIdValue, tamper };
    }
    const current = await modules.schedulerStoreModule.readRecordSchedulerLedgerStore(taskIdValue, { expectPublished: true });
    assert.equal(current.kind, "current", "只能篡改一份已落盘 scheduler ledger");
    if (current.kind !== "current") throw new Error("production recovery ledger unavailable for tamper case");
    if (tamper === "identity") {
        assert.ok(current.ledger.schedulerOwner, "identity tamper case requires the persisted scheduler owner lease");
        await modules.schedulerStoreModule.mutateRecordSchedulerLedgerAsOwner(
            taskIdValue,
            current.ledger.revision,
            current.ledger.schedulerOwner,
            ledger => {
                const attempt = ledger.attempts.find(candidate => candidate.managedByProductionPump === true);
                if (!attempt) throw new Error("identity tamper case missing production attempt");
                attempt.idempotencyKey = `forged-${attempt.idempotencyKey}`;
            },
        );
        return { taskId: taskIdValue, tamper };
    }
    if (tamper === "source-hash") {
        const source = current.ledger.sourceSnapshots[0];
        if (!source) throw new Error("source hash tamper case missing source snapshot");
        const sourcePath = path.resolve(dataRoot, source.contentRef.path);
        const bytes = fs.readFileSync(sourcePath);
        bytes[0] = bytes[0] ^ 1;
        fs.writeFileSync(sourcePath, bytes);
        return { taskId: taskIdValue, tamper };
    }
    if (tamper === "provider-control") {
        const paths = modules.providerControlStoreModule.resolveProviderControlPaths({ dataRoot });
        fs.writeFileSync(paths.controlPath, "{broken-provider-control", "utf8");
        return { taskId: taskIdValue, tamper };
    }
    throw new Error(`unsupported production tamper: ${tamper}`);
}

async function recoverProduction() {
    assert.deepEqual(Object.keys(config).sort(), ["providerUrl"], "recovery child 只允许外注 provider endpoint");
    assert.equal(typeof config.providerUrl, "string");
    const modules = await loadProductionModules();
    const taskIdValue = scanSingleProductionTask(modules.schedulerStoreModule);
    const spool = modules.spoolModule.createRecordSchedulerSpool({ dataRoot });
    const control = modules.controlModule.createRecordSchedulerControl({ dataRoot, spool });
    let persistedMetadata = null;
    let callbackExecuted = false;
    let recovery = null;
    let executionError = null;
    const runtimeOwnerId = `hard-exit-runtime-recovery-owner-${taskIdValue}-${process.pid}`;
    const runtime = modules.runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: runtimeOwnerId,
        ownerLeaseMs: 30_000,
        now: () => new Date(Date.now() + 60_000),
        control,
        sourceEvidenceAdapter: { buildDiscoveryInput: async () => { throw new Error("sealed recovery must not perform live discovery"); } },
        productionSourceReader: { scan: async () => { throw new Error("sealed recovery must not perform live source reads"); } },
        executeForTest: async () => "recovery child must use resumeExecution",
    });
    try {
        recovery = await runtime.resumeExecution(
            taskIdValue,
            recoveryContext(taskIdValue),
            async (_context, _snapshot, frozenSources) => {
                callbackExecuted = true;
                assert.ok(frozenSources, "runtime resumeExecution 必须从磁盘重建 sealed frozen sources");
                assert.ok(persistedMetadata, "descriptor factory 必须先从 admission capsule 重建 execution metadata");
                const frozenConversationId = frozenSources.sources[0]?.snapshot?.conversationId;
                assert.equal(frozenConversationId, `conversation-${persistedMetadata.requestIdentity}`, "恢复身份必须与 frozen source 一致");
                return JSON.stringify(await executeProductionPath({
                    taskId: taskIdValue,
                    frozenSources,
                    control,
                    spool,
                    modules,
                    providerUrl: config.providerUrl,
                    requestIdentity: persistedMetadata.requestIdentity,
                    providerBehavior: persistedMetadata.providerBehavior,
                    finalize: persistedMetadata.finalize,
                    recovering: true,
                    schedulerOwnerId: runtimeOwnerId,
                }));
            },
            async () => {
                const persisted = await loadPersistedRecoveryDescriptor(modules, taskIdValue);
                persistedMetadata = persisted.metadata;
                return persisted.runtimeDescriptor;
            },
        );
    } catch (error) {
        executionError = error;
    }
    let providerResultText = null;
    if (recovery?.result) {
        const parsed = JSON.parse(recovery.result);
        providerResultText = parsed.providerResultText ?? null;
    }
    if (!executionError && (recovery?.kind === "repair_required" || recovery?.kind === "missing" || recovery?.kind === "blocked")) {
        executionError = Object.assign(new Error(recovery.reason || recovery.result || recovery.kind), { code: recovery.kind.toUpperCase() });
    }
    return {
        execution: {
            providerResultText,
            errorCode: executionError ? executionError.code || executionError.name || "ERROR" : null,
            errorMessage: executionError ? executionError.message || String(executionError) : null,
            callbackExecuted,
        },
        durable: await inspectProductionState(modules),
    };
}

try {
    let result;
    if (action === "crash-output-spool") result = await crashDuringOutputSpool();
    else if (action === "recover-output-spool") result = await recoverAfterOutputSpoolCrash();
    else if (action === "crash-commit") result = await crashDuringCommit();
    else if (action === "recover-commit") result = await recoverExistingCommit();
    else if (action === "verify-higher-epoch") result = await verifyHigherEpochBlocksOldRecovery();
    else if (action === "crash-production-scheduler" || action === "crash-production-commit") result = await crashProduction(action);
    else if (action === "inspect-production-state") result = await inspectProductionState(await loadProductionModules());
    else if (action === "tamper-production-state") result = await tamperPersistedProductionState();
    else if (action === "recover-production") result = await recoverProduction();
    else throw new Error(`unknown worker action: ${action}`);
    console.log(JSON.stringify(result));
} catch (error) {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
}
