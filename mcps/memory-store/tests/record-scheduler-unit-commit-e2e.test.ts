import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RecordSourceIdentity } from "../src/record-discovery.ts";
import type { SourceEvidenceHost } from "../src/source-evidence-contracts.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-unit-commit-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const {
    buildRecordIndexScope,
    discoverRecordCandidates,
} = await import("../src/record-discovery.ts");
const {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
} = await import("../src/source-evidence-contracts.ts");
const {
    createRecordSchedulerRuntime,
    recordSchedulerRequestKey,
} = await import("../src/record-scheduler-runtime.ts");
const { createRecordSchedulerControl } = await import("../src/record-scheduler-control.ts");
const { createRecordSchedulerSpool } = await import("../src/record-scheduler-spool.ts");
const { getBackgroundTask } = await import("../src/background-tasks.ts");
const { readRecordSchedulerLedgerStore } = await import("../src/record-scheduler-store.ts");
const { readRecordWorkRegistry, startOrAttachRecordWork } = await import("../src/record-work-registry.ts");
const recordStore = await import("../src/record-store.ts");
const readerStore = await import("../src/record-update-coordination.ts");
const driver = await import("../src/record-scheduler-execution-driver.ts");

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(message);
}

const fixtureTimeMs = Date.parse("2026-07-14T00:00:00.000Z");

function fixtureSource(conversationId: string): RecordSourceIdentity {
    return {
        host: "codex",
        identity: {
            workspace: { workspaceId: "C:/fixtures/unit-driver", canonicalPath: "C:/fixtures/unit-driver" },
            source: {
                kind: "filesystem",
                authority: "C:/fixtures/unit-driver/authority",
                authoritativeRoot: "C:/fixtures/unit-driver/authority",
                canonicalPath: "C:/fixtures/unit-driver/store",
            },
            conversationId,
        },
    };
}

function fixtureEnumeration(source: RecordSourceIdentity, revision: string, sequence: number) {
    const observedAt = new Date(fixtureTimeMs + sequence * 1_000).toISOString();
    const evidence = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: source.host,
        identity: source.identity,
        sourceRevision: { revision, contentCursor: `cursor-${revision}`, eventWatermark: `event-${revision}`, sequence },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: { scanId: `scan-${source.identity.conversationId}`, sequence, startedAt: observedAt, completedAt: observedAt },
        targetStatus: "present",
    });
    return { evidence, revisionSequence: sequence, title: source.identity.conversationId };
}

function fixtureScope(source: RecordSourceIdentity) {
    return buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `index-${source.identity.conversationId}`,
        indexRevision: "index-revision-1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
}

const sourceA = fixtureSource("unit-commit-a");
const sourceB = fixtureSource("unit-commit-b");
const sourceC = fixtureSource("unit-commit-cancel");
const sourceD = fixtureSource("unit-commit-fenced");
const sourcesByConversation = new Map([
    [sourceA.identity.conversationId, sourceA],
    [sourceB.identity.conversationId, sourceB],
    [sourceC.identity.conversationId, sourceC],
    [sourceD.identity.conversationId, sourceD],
]);
const enumerations = new Map([
    [sourceA.identity.conversationId, fixtureEnumeration(sourceA, "revision-2", 2)],
    [sourceB.identity.conversationId, fixtureEnumeration(sourceB, "revision-2", 3)],
    [sourceC.identity.conversationId, fixtureEnumeration(sourceC, "revision-2", 4)],
    [sourceD.identity.conversationId, fixtureEnumeration(sourceD, "revision-2", 5)],
]);
function discoveryInputFor(snapshotId: string, sources: RecordSourceIdentity[]) {
    return {
        request: { snapshotId, discoveredAtSequence: sources.length + 1, filters: { hosts: [], workspace: null, extensions: {} } },
        sourceEnumerations: sources.map(source => enumerations.get(source.identity.conversationId)!),
        recordIndex: { scopes: [fixtureScope(sources[0]!)], entries: [] },
    };
}

const discoveryInput = discoveryInputFor("unit-commit-frozen-snapshot", [sourceA, sourceB]);
const discoveredCandidates = discoverRecordCandidates(discoveryInput).candidates;
assert.equal(discoveredCandidates.length, 2);
assert.deepEqual(
    discoveredCandidates.map(candidate => candidate.classification),
    ["Missing", "Missing"],
    "fixture must select two missing candidates through the normal scheduler path",
);

const productionSourceReader = {
    async scan(request: { host: SourceEvidenceHost; conversationId: string; workspace: { workspaceId: string; canonicalPath: string | null } }) {
        const source = sourcesByConversation.get(request.conversationId);
        if (!source) throw new Error(`unexpected fixture source ${request.conversationId}`);
        assert.equal(request.host, source.host);
        assert.equal(request.workspace.workspaceId, source.identity.workspace.workspaceId);
        const enumerationRecord = enumerations.get(source.identity.conversationId)!;
        const exactFetch = buildExactFetchEvidence({
            adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: source.host,
            identity: source.identity,
            sourceRevision: enumerationRecord.evidence.sourceRevision,
            pagination: enumerationRecord.evidence.pagination,
            enumerationComplete: true,
            cacheBypassed: true,
            exactFetchResult: "present",
            errors: [],
            warnings: [],
            observedAt: enumerationRecord.evidence.observedAt,
        });
        const document = {
            schemaVersion: "record-source-content/v1" as const,
            formatterVersion: "canonical-json-nfc-lf/v1" as const,
            source: { host: source.host, conversationId: source.identity.conversationId },
            messages: [
                { order: 1, role: "user" as const, content: `fixture request ${source.identity.conversationId}` },
                { order: 2, role: "assistant" as const, content: `fixture response ${source.identity.conversationId}` },
            ],
        };
        const bytes = Buffer.from(JSON.stringify(document), "utf8");
        const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const fullEvidence = buildFullSourceReadEvidence({
            adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: source.host,
            identity: source.identity,
            sourceRevision: enumerationRecord.evidence.sourceRevision,
            pagination: enumerationRecord.evidence.pagination,
            enumerationComplete: true,
            cacheBypassed: true,
            exactFetchResult: "present",
            errors: [],
            warnings: [],
            observedAt: enumerationRecord.evidence.observedAt,
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
            scanId: enumerationRecord.evidence.observedAt.scanId,
            enumeration: enumerationRecord.evidence,
            exactFetch,
            fullSourceRead: {
                status: "complete" as const,
                evidence: fullEvidence,
                payload: {
                    schemaVersion: document.schemaVersion,
                    formatterVersion: document.formatterVersion,
                    mediaType: "application/vnd.memory-store.record-source+json" as const,
                    encoding: "utf-8" as const,
                    bytes,
                    byteLength: bytes.byteLength,
                    contentHash,
                },
                sourceSnapshot: null,
                authority: {
                    identityHash: createHash("sha256").update(canonicalSerialize(source.identity)).digest("hex"),
                    revisionHash: createHash("sha256").update(enumerationRecord.evidence.sourceRevision.revision).digest("hex"),
                    identityStable: true,
                    revisionStable: true,
                    cacheBypassed: true,
                    enumerationEvidenceHash: enumerationRecord.evidence.evidenceHash,
                    exactFetchEvidenceHash: exactFetch.evidenceHash,
                    fullReadEvidenceHash: fullEvidence.evidenceHash,
                },
                issues: [],
            },
            sourceSnapshot: null,
            classification: { state: "Present" as const, reason: "unit-driver-fixture-reader" },
            qualifiedAbsence: null,
        };
    },
};

const spool = createRecordSchedulerSpool({ dataRoot });
const control = createRecordSchedulerControl({ dataRoot, spool });
const firstFault = deferred<unknown>();
const runtimeCompletionHold = deferred<void>();
let generateCalls = 0;
let firstInput: Parameters<typeof driver.executeRecordSchedulerUnitCommit>[0] | undefined;
let sourceSet: any;

const runtime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "unit-commit-driver-owner",
    control,
    sourceEvidenceAdapter: {
        buildDiscoveryInput: async () => discoveryInput as never,
    },
    productionSourceReader: productionSourceReader as never,
    executeForTest: async request => {
        assert.ok(request.sourceSnapshots);
        sourceSet = request.sourceSnapshots;
        firstInput = {
            taskId: request.taskId,
            frozenSources: request.sourceSnapshots,
            sourceSnapshotId: request.sourceSnapshots.sources[0]!.snapshot.sourceSnapshotId,
            recordStoreHash: "unit-commit-e2e-records",
            schedulerOwner: { ownerId: "unit-commit-driver-owner", leaseMs: 120_000, workLeaseMs: 120_000 },
            control,
            spool,
            generateRecord: async context => {
                generateCalls += 1;
                return `# ${context.source.snapshot.conversationId}\n\n由 immutable spool 驱动的正文`;
            },
            commit: {
                firstPublicationToken: "unit-commit-e2e-first-publication",
                provider: "codex",
                model: "fake-codex-compose-window",
                hooks: {
                    onFaultPoint: async event => {
                        if (event.stage === "MainIndexWritten" && event.point === "after_write") {
                            throw new Error("injected commit interruption");
                        }
                    },
                },
            },
        };
        try {
            await driver.executeRecordSchedulerUnitCommit(firstInput);
            firstFault.reject(new Error("expected injected commit interruption"));
        } catch (error) {
            firstFault.resolve(error);
        }
        await runtimeCompletionHold.promise;
        return "unit commit test runtime released";
    },
});

const requestSummary = {
    operation: "record-batch-update",
    workspaceHash: "unit-commit-workspace",
    dataChain: "codex",
    modelChain: "codex",
};
const admission = await runtime.admit({
    kind: "record-batch-update",
    requestKey: recordSchedulerRequestKey("record-batch-update", requestSummary),
    requestSummary,
    resumePayload: { kind: "record-batch-update", workspace: dataRoot, dataChain: "codex", modelChain: "codex" },
    requestMode: "normal",
    discovery: { kind: "record-batch-update", selector: "normal", input: discoveryInput as never },
    execute: async () => "must not run in test mode",
});

assert.equal(admission.outcome, "Admitted");
if (admission.outcome === "UnknownOutcome") {
    throw new Error(`scheduler admission failed: ${admission.reasons.join("; ")}`);
}
await waitFor(
    () => firstInput !== undefined,
    `runtime 未在超时前进入 unit execution driver; state=${runtime.status(admission.taskId)?.state ?? "missing"}`,
);
assert.ok(
    firstInput,
    `runtime execution failed before entering driver; state=${runtime.status(admission.taskId)?.state ?? "missing"}; error=${getBackgroundTask(admission.taskId)?.error ?? "missing"}`,
);
const interruption = await firstFault.promise;
assert.match(interruption instanceof Error ? interruption.message : String(interruption), /injected commit interruption/u);
assert.equal(generateCalls, 1, "first work must call provider exactly once before interruption");
assert.ok(firstInput);
assert.ok(sourceSet);
assert.equal(sourceSet.sources.length, 2, "runtime must hand the driver a sealed two-candidate source set");
await assert.rejects(
    () => driver.executeRecordSchedulerUnitCommit({ ...firstInput!, sourceSnapshotId: undefined, commit: { ...firstInput!.commit, hooks: undefined } }),
    (error: unknown) => error instanceof driver.RecordSchedulerExecutionDriverError && error.code === "AMBIGUOUS_WORK",
);

const recoveredA = await driver.executeRecordSchedulerUnitCommit({ ...firstInput!, commit: { ...firstInput!.commit, hooks: undefined } });
assert.equal(recoveredA.kind, "verified");
if (recoveredA.kind !== "verified") throw new Error("KnownSuccess recovery must produce a verified commit");
assert.equal(recoveredA.commit.kind, "verified");
assert.equal(generateCalls, 1, "commit recovery with KnownSuccess output must not repeat provider work");

const sourceBId = sourceSet.sources.find((source: any) => source.snapshot.conversationId === sourceB.identity.conversationId)!.snapshot.sourceSnapshotId;
const completedB = await driver.executeRecordSchedulerUnitCommit({
    ...firstInput!,
    sourceSnapshotId: sourceBId,
    commit: { ...firstInput!.commit, hooks: undefined },
});
assert.equal(completedB.kind, "verified");
if (completedB.kind !== "verified") throw new Error("distinct batch work must produce a verified commit");
assert.equal(completedB.commit.kind, "verified");
assert.equal(generateCalls, 2, "same scheduler task must run provider once for a distinct selected work");
assert.notEqual(recoveredA.recordWorkKey, completedB.recordWorkKey);
assert.notEqual(recoveredA.commitId, completedB.commitId);
assert.notEqual(recoveredA.idempotencyKey, completedB.idempotencyKey);

for (const result of [recoveredA, completedB]) {
    const bodyTarget = {
        kind: "record_body" as const,
        conversationId: result.commitLedger.binding.conversationId,
        recordId: result.commitLedger.binding.recordId,
        relativePath: recordStore.getRecordCommitArtifactRelativePath("record_body", result.commitLedger.binding.conversationId),
    };
    const mainTarget = {
        kind: "main_index" as const,
        conversationId: result.commitLedger.binding.conversationId,
        recordId: result.commitLedger.binding.recordId,
        relativePath: recordStore.getRecordCommitArtifactRelativePath("main_index", result.commitLedger.binding.conversationId),
    };
    const readerTarget = {
        kind: "reader_index" as const,
        conversationId: result.commitLedger.binding.conversationId,
        recordId: result.commitLedger.binding.recordId,
        relativePath: recordStore.getRecordCommitArtifactRelativePath("reader_index", result.commitLedger.binding.conversationId),
    };
    const [body, main, reader] = await Promise.all([
        recordStore.readRecordCommitBodyArtifact("unit-commit-e2e-records", bodyTarget),
        recordStore.readRecordCommitMainIndexArtifact("unit-commit-e2e-records", mainTarget),
        readerStore.readRecordCommitReaderIndexArtifact("unit-commit-e2e-records", readerTarget),
    ]);
    assert.equal(body.body, result.content);
    assert.equal(body.ownerCommitId, result.commitId);
    assert.deepEqual(main.value, result.commitLedger.payload.mainIndexEntry);
    assert.deepEqual(reader.value, result.commitLedger.payload.readerIndex);
    assert.equal(main.ownerCommitId, result.commitId);
    assert.equal(reader.ownerCommitId, result.commitId);
}

assert.equal(
    runtime.status(admission.taskId)?.state,
    "Running",
    `driver recovery 时 runtime 不应提前结算: ${getBackgroundTask(admission.taskId)?.error ?? "missing"}`,
);

const cancellationResult = deferred<Awaited<ReturnType<typeof driver.executeRecordSchedulerUnitCommit>>>();
const cancellationRuntimeHold = deferred<void>();
let cancellationProviderCalls = 0;
const cancellationRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "unit-commit-cancellation-owner",
    control,
    sourceEvidenceAdapter: {
        buildDiscoveryInput: async () => discoveryInputFor("unit-commit-cancellation-snapshot", [sourceC]) as never,
    },
    productionSourceReader: productionSourceReader as never,
    executeForTest: async request => {
        assert.ok(request.sourceSnapshots);
        assert.equal(request.sourceSnapshots.sources.length, 1);
        const sourceSnapshotId = request.sourceSnapshots.sources[0]!.snapshot.sourceSnapshotId;
        const input = {
            taskId: request.taskId,
            frozenSources: request.sourceSnapshots,
            sourceSnapshotId,
            recordStoreHash: "unit-commit-e2e-records",
            schedulerOwner: { ownerId: "unit-commit-cancellation-owner", leaseMs: 120_000, workLeaseMs: 120_000 },
            control,
            spool,
            generateRecord: async (context: Parameters<typeof driver.executeRecordSchedulerUnitCommit>[0]["generateRecord"] extends (context: infer Context) => Promise<unknown> ? Context : never) => {
                cancellationProviderCalls += 1;
                const location = {
                    dataRoot,
                    identity: {
                        chain: context.source.snapshot.chain,
                        workspaceHash: context.source.snapshot.workspaceHash,
                        conversationId: context.source.snapshot.conversationId,
                    },
                };
                const registry = await readRecordWorkRegistry(location);
                assert.equal(registry.kind, "ready");
                if (registry.kind !== "ready") throw new Error("shared record work registry must be readable");
                const peerTaskId = "unit-commit-cancellation-peer";
                const attached = await startOrAttachRecordWork({
                    ...location,
                    desiredRevision: context.source.snapshot.desiredRevision,
                    taskId: peerTaskId,
                    expectedRegistryRevision: registry.registry.registryRevision,
                });
                assert.equal(attached.kind, "started");
                const cancellation = await control.cancel(request.taskId);
                assert.equal(cancellation.disposition, "cancelling");
                return {
                    content: "# cancelled provider output\n\n只允许进入 task spool",
                    qualityHash: "must-not-reach-quality-validation",
                };
            },
            commit: {
                firstPublicationToken: "unit-commit-cancellation-first-publication",
                provider: "codex",
                model: "fake-codex-compose-window",
            },
        };
        try {
            cancellationResult.resolve(await driver.executeRecordSchedulerUnitCommit(input));
        } catch (error) {
            cancellationResult.reject(error);
        }
        await cancellationRuntimeHold.promise;
        return "cancellation runtime held for e2e assertions";
    },
});

const cancellationRequestSummary = { ...requestSummary, operation: "record-update", scenario: "late-provider-cancel" };
const cancellationAdmission = await cancellationRuntime.admit({
    kind: "record-update",
    requestKey: recordSchedulerRequestKey("record-update", cancellationRequestSummary),
    requestSummary: cancellationRequestSummary,
    resumePayload: { kind: "record-update", scenario: "late-provider-cancel", workspace: dataRoot },
    requestMode: "normal",
    discovery: { kind: "record-update", selector: "normal", input: discoveryInputFor("unit-commit-cancellation-snapshot", [sourceC]) as never },
    execute: async () => "must not run in test mode",
});
assert.equal(cancellationAdmission.outcome, "Admitted");
if (cancellationAdmission.outcome === "UnknownOutcome") throw new Error(`cancellation admission failed: ${cancellationAdmission.reasons.join("; ")}`);
const cancelled = await cancellationResult.promise;
assert.equal(cancelled.kind, "discarded");
assert.equal(cancellationProviderCalls, 1, "cancelled provider must still return exactly once");
assert.equal(cancelled.cancellation.state, "Cancelling");
const cancelledLedger = await readRecordSchedulerLedgerStore(cancellationAdmission.taskId, { expectPublished: true });
assert.equal(cancelledLedger.kind, "current");
if (cancelledLedger.kind !== "current") throw new Error("cancelled task ledger must remain readable");
const cancelledAttempt = cancelledLedger.ledger.attempts.find(attempt => attempt.attemptId === cancelled.attemptId);
const cancelledUnit = cancelledLedger.ledger.units.find(unit => unit.unitId === cancelled.unitId);
const cancelledWork = cancelledLedger.ledger.recordWork.find(work => work.recordWorkKey === cancelled.recordWorkKey);
assert.equal(cancelledAttempt?.state, "Discarded");
assert.equal(cancelledAttempt?.outcome, "discarded");
assert.deepEqual(cancelledAttempt?.outputRef, cancelled.outputRef);
assert.equal(cancelledUnit?.state, "Discarded");
assert.equal(cancelledLedger.ledger.commits.length, 0, "cancelled late output must not create a commit");
assert.ok(cancelledWork?.activeTaskIds.includes("unit-commit-cancellation-peer"));
assert.ok(!cancelledWork?.activeTaskIds.includes(cancellationAdmission.taskId));
const cancelledRegistry = await readRecordWorkRegistry({
    dataRoot,
    identity: {
        chain: sourceC.host,
        workspaceHash: sourceC.identity.workspace.workspaceId,
        conversationId: sourceC.identity.conversationId,
    },
});
assert.equal(cancelledRegistry.kind, "ready");
if (cancelledRegistry.kind !== "ready") throw new Error("cancelled shared work registry must remain readable");
const cancelledRegistryWork = cancelledRegistry.registry.works.find(work => work.recordWorkKey === cancelled.recordWorkKey);
assert.ok(cancelledRegistryWork?.activeTaskIds.includes("unit-commit-cancellation-peer"));
assert.ok(!cancelledRegistryWork?.activeTaskIds.includes(cancellationAdmission.taskId));

const fenceResult = deferred<unknown>();
const fenceRuntimeHold = deferred<void>();
let fenceProviderCalls = 0;
let fenceNowMs = Date.now() + 60_000;
const fenceClock = {
    now: () => new Date(fenceNowMs).toISOString(),
    nowMs: () => fenceNowMs,
};
const fenceRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "unit-commit-fence-owner",
    control,
    sourceEvidenceAdapter: {
        buildDiscoveryInput: async () => discoveryInputFor("unit-commit-fence-snapshot", [sourceD]) as never,
    },
    productionSourceReader: productionSourceReader as never,
    executeForTest: async request => {
        assert.ok(request.sourceSnapshots);
        const input = {
            taskId: request.taskId,
            frozenSources: request.sourceSnapshots,
            sourceSnapshotId: request.sourceSnapshots.sources[0]!.snapshot.sourceSnapshotId,
            recordStoreHash: "unit-commit-e2e-records",
            schedulerOwner: { ownerId: "unit-commit-fence-owner", leaseMs: 100, workLeaseMs: 100 },
            control,
            spool,
            generateRecord: async () => {
                fenceProviderCalls += 1;
                fenceNowMs += 1_000;
                const replacement = await control.recoverOwner({
                    taskId: request.taskId,
                    ownerId: "unit-commit-fence-replacement",
                    leaseMs: 100,
                    workLeaseMs: 100,
                    nowMs: fenceNowMs,
                });
                assert.equal(replacement.kind, "recovered", replacement.kind === "recovered" ? undefined : replacement.reason);
                return "# stale owner provider output\n\n不得提交";
            },
            commit: {
                firstPublicationToken: "unit-commit-fence-first-publication",
                provider: "codex",
                model: "fake-codex-compose-window",
                clock: fenceClock,
                leaseMs: 100,
                workLeaseMs: 100,
            },
        };
        try {
            await driver.executeRecordSchedulerUnitCommit(input);
            fenceResult.reject(new Error("expected fenced owner to reject late provider result"));
        } catch (error) {
            fenceResult.resolve(error);
        }
        await fenceRuntimeHold.promise;
        return "fence runtime held for e2e assertions";
    },
});

const fenceRequestSummary = { ...requestSummary, operation: "record-update", scenario: "late-provider-fence" };
const fenceAdmission = await fenceRuntime.admit({
    kind: "record-update",
    requestKey: recordSchedulerRequestKey("record-update", fenceRequestSummary),
    requestSummary: fenceRequestSummary,
    resumePayload: { kind: "record-update", scenario: "late-provider-fence", workspace: dataRoot },
    requestMode: "normal",
    discovery: { kind: "record-update", selector: "normal", input: discoveryInputFor("unit-commit-fence-snapshot", [sourceD]) as never },
    execute: async () => "must not run in test mode",
});
assert.equal(fenceAdmission.outcome, "Admitted");
if (fenceAdmission.outcome === "UnknownOutcome") throw new Error(`fence admission failed: ${fenceAdmission.reasons.join("; ")}`);
const fenceError = await fenceResult.promise;
assert.ok(fenceError instanceof driver.RecordSchedulerExecutionDriverError, fenceError instanceof Error ? fenceError.stack : String(fenceError));
assert.equal(fenceError.code, "OWNER_UNAVAILABLE");
assert.equal(fenceProviderCalls, 1, "fenced provider must return only once");
const fencedLedger = await readRecordSchedulerLedgerStore(fenceAdmission.taskId, { expectPublished: true, nowMs: fenceNowMs });
assert.equal(fencedLedger.kind, "current");
if (fencedLedger.kind !== "current") throw new Error("fenced task ledger must remain readable");
assert.equal(fencedLedger.ledger.schedulerOwner?.ownerId, "unit-commit-fence-replacement");
assert.equal(fencedLedger.ledger.commits.length, 0, "fenced owner must not create a commit");
assert.equal(fencedLedger.ledger.attempts.length, 1);
assert.equal(fencedLedger.ledger.attempts[0]!.state, "Dispatched");
assert.equal(fencedLedger.ledger.attempts[0]!.outputRef, undefined);

runtimeCompletionHold.resolve(undefined);
cancellationRuntimeHold.resolve(undefined);
fenceRuntimeHold.resolve(undefined);
await waitFor(
    () => [admission.taskId, cancellationAdmission.taskId, fenceAdmission.taskId]
        .every(taskId => ["done", "error"].includes(getBackgroundTask(taskId)?.status || "")),
    "unit commit e2e runtimes did not release their owner heartbeats",
);

console.log("record scheduler unit commit e2e tests passed");
