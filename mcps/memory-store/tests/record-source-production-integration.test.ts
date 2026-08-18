import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-source-production-integration-"));
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const discovery = await import("../src/record-discovery.ts");
const evidence = await import("../src/source-evidence-contracts.ts");
const production = await import("../src/record-production-source-readers.ts");
const runtimeModule = await import("../src/record-scheduler-runtime.ts");
const controlModule = await import("../src/record-scheduler-control.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");
const stateStore = await import("../src/record-conversation-state.ts");
const workRegistry = await import("../src/record-work-registry.ts");
const contracts = await import("../src/record-scheduler-contracts.ts");

const baseTimeMs = Date.parse("2026-07-14T00:00:00.000Z");
let clockMs = baseTimeMs;

interface MutableSource {
    revision: string;
    revisionSequence: number;
    body: string;
    scanCalls: number;
    scanSequence: number;
}

interface RuntimeFixture {
    runtime: InstanceType<typeof runtimeModule.RecordSchedulerRuntime>;
    reader: ReturnType<typeof createOfflineProductionReader>;
    executed: Array<{ taskId: string; sourceSnapshots: unknown }>;
}

interface PreparedGuardCommit {
    sourceSnapshotId: string;
    recordWorkKey: string;
    commitId: string;
}

function now(): Date {
    return new Date(clockMs);
}

function sha256(value: Uint8Array | string): string {
    return createHash("sha256").update(value).digest("hex");
}

function sourceIdentity(workspaceHash: string, workspacePath: string, conversationId: string) {
    return {
        host: "codex" as const,
        identity: {
            workspace: { workspaceId: workspaceHash, canonicalPath: workspacePath },
            source: {
                kind: "filesystem" as const,
                authority: `${workspacePath}/authority`,
                authoritativeRoot: `${workspacePath}/authority`,
                canonicalPath: `${workspacePath}/source`,
            },
            conversationId,
        },
    };
}

function sourceEnumeration(
    source: ReturnType<typeof sourceIdentity>,
    revision: string,
    revisionSequence: number | null,
    scanId: string,
    completedAtMs: number,
    targetStatus: "present" | "absent" = "present",
) {
    return evidence.buildSourceEnumerationEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity: source.identity,
        sourceRevision: {
            revision,
            contentCursor: `cursor-${revision}`,
            eventWatermark: `watermark-${revision}`,
            sequence: revisionSequence,
        },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: targetStatus === "present" ? "present" : "not_found",
        errors: [],
        warnings: [],
        observedAt: {
            scanId,
            sequence: revisionSequence ?? 1,
            startedAt: new Date(completedAtMs - 1).toISOString(),
            completedAt: new Date(completedAtMs).toISOString(),
        },
        targetStatus,
    });
}

function discoveryInput(input: {
    workspaceHash: string;
    workspacePath: string;
    conversationId: string;
    revision: string;
    revisionSequence?: number;
    coveredRevision?: string | null;
    scanId?: string;
    completedAtMs?: number;
}) {
    const source = sourceIdentity(input.workspaceHash, input.workspacePath, input.conversationId);
    const revisionSequence = input.revisionSequence ?? 1;
    const enumeration = sourceEnumeration(
        source,
        input.revision,
        revisionSequence,
        input.scanId || `discovery-${input.conversationId}-${input.revision}`,
        input.completedAtMs ?? clockMs,
    );
    const scope = discovery.buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `index-${input.conversationId}`,
        indexRevision: `index-${input.revision}`,
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
    const entries = input.coveredRevision === undefined || input.coveredRevision === null
        ? []
        : [discovery.buildRecordIndexEntry({
            recordId: `record-${input.conversationId}`,
            source,
            indexSnapshotId: scope.snapshotId,
            indexRevision: scope.indexRevision,
            coveredRevision: { revision: input.coveredRevision, sequence: revisionSequence },
            recordBodyHash: `sha256:${sha256(`body-${input.conversationId}-${input.coveredRevision}`)}`,
            extensions: {},
        })];
    return {
        request: {
            snapshotId: `snapshot-${input.conversationId}-${input.revision}-${input.scanId || "default"}`,
            discoveredAtSequence: revisionSequence,
            filters: { hosts: ["codex"], workspace: input.workspacePath, extensions: {} },
        },
        sourceEnumerations: [{ evidence: enumeration, revisionSequence, title: input.conversationId }],
        recordIndex: { scopes: [scope], entries },
        absenceObservations: [],
    };
}

function absenceInput(input: {
    workspaceHash: string;
    workspacePath: string;
    conversationId: string;
    scanId: string;
    sequence: number;
    completedAtMs: number;
}) {
    const source = sourceIdentity(input.workspaceHash, input.workspacePath, input.conversationId);
    const enumeration = sourceEnumeration(
        source,
        `absent-${input.scanId}`,
        null,
        input.scanId,
        input.completedAtMs,
        "absent",
    );
    const exactFetch = evidence.buildExactFetchEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity: source.identity,
        sourceRevision: enumeration.sourceRevision,
        pagination: enumeration.pagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: enumeration.observedAt,
    });
    const lostEvidence = evidence.buildLostObservation({ enumeration, exactFetch });
    const scope = discovery.buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `absence-index-${input.conversationId}`,
        indexRevision: "absence-index-v1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
    const entry = discovery.buildRecordIndexEntry({
        recordId: `record-${input.conversationId}`,
        source,
        indexSnapshotId: scope.snapshotId,
        indexRevision: scope.indexRevision,
        coveredRevision: { revision: "covered-before-absence", sequence: 1 },
        recordBodyHash: `sha256:${sha256(`body-${input.conversationId}`)}`,
        extensions: {},
    });
    return {
        request: {
            snapshotId: `absence-snapshot-${input.conversationId}-${input.scanId}`,
            discoveredAtSequence: input.sequence,
            filters: { hosts: ["codex"], workspace: input.workspacePath, extensions: {} },
        },
        sourceEnumerations: [{ evidence: enumeration, revisionSequence: null, title: input.conversationId }],
        recordIndex: { scopes: [scope], entries: [entry] },
        absenceObservations: [{
            confirmation: "absence_recheck" as const,
            evidence: lostEvidence,
            observedAtMs: input.completedAtMs,
        }],
    };
}

function createOfflineProductionReader(source: MutableSource) {
    const scan = async (request: { host: "codex"; conversationId: string; workspace: { workspaceId: string; canonicalPath: string | null } }) => {
        source.scanCalls += 1;
        source.scanSequence += 1;
        const completedAtMs = clockMs + source.scanSequence;
        const workspacePath = request.workspace.canonicalPath || dataRoot;
        const identity = sourceIdentity(request.workspace.workspaceId, workspacePath, request.conversationId);
        const enumeration = sourceEnumeration(
            identity,
            source.revision,
            source.revisionSequence,
            `production-scan-${request.conversationId}-${source.scanSequence}`,
            completedAtMs,
        );
        const exactFetch = evidence.buildExactFetchEvidence({
            adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: "codex",
            identity: identity.identity,
            sourceRevision: enumeration.sourceRevision,
            pagination: enumeration.pagination,
            enumerationComplete: true,
            cacheBypassed: true,
            exactFetchResult: "present",
            errors: [],
            warnings: [],
            observedAt: enumeration.observedAt,
        });
        const document = {
            schemaVersion: production.PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
            formatterVersion: production.PRODUCTION_SOURCE_FORMATTER_VERSION,
            source: { host: "codex" as const, conversationId: request.conversationId },
            messages: [
                { order: 1, role: "user" as const, content: `source ${source.revision}` },
                { order: 2, role: "assistant" as const, content: source.body },
            ],
        };
        const bytes = Buffer.from(JSON.stringify(document), "utf8");
        const contentHash = `sha256:${sha256(bytes)}`;
        const fullEvidence = evidence.buildFullSourceReadEvidence({
            adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: "codex",
            identity: identity.identity,
            sourceRevision: enumeration.sourceRevision,
            pagination: enumeration.pagination,
            enumerationComplete: true,
            cacheBypassed: true,
            exactFetchResult: "present",
            errors: [],
            warnings: [],
            observedAt: {
                ...enumeration.observedAt,
                scanId: `production-full-${request.conversationId}-${source.scanSequence}`,
                sequence: source.revisionSequence + 100,
            },
            content: {
                mode: "full" as const,
                byteLength: bytes.byteLength,
                contentHash,
                roundRange: { start: 1, end: 2 },
                truncated: false,
                staleCache: false,
            },
        });
        const fullSourceRead = {
            status: "complete" as const,
            evidence: fullEvidence,
            payload: {
                schemaVersion: production.PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
                formatterVersion: production.PRODUCTION_SOURCE_FORMATTER_VERSION,
                mediaType: "application/vnd.memory-store.record-source+json" as const,
                encoding: "utf-8" as const,
                bytes,
                byteLength: bytes.byteLength,
                contentHash,
            },
            sourceSnapshot: null,
            authority: {
                identityHash: sha256(JSON.stringify(identity.identity)),
                revisionHash: sha256(source.revision),
                identityStable: true,
                revisionStable: true,
                cacheBypassed: true,
                enumerationEvidenceHash: enumeration.evidenceHash,
                exactFetchEvidenceHash: exactFetch.evidenceHash,
                fullReadEvidenceHash: fullEvidence.evidenceHash,
            },
            issues: [],
        };
        return {
            host: "codex" as const,
            scanId: `production-reader-${source.scanSequence}`,
            enumeration,
            exactFetch,
            fullSourceRead,
            sourceSnapshot: null,
            classification: { state: "Present" as const, reason: "offline-production-reader-present" },
            qualifiedAbsence: null,
        };
    };
    return { scan };
}

function createRuntimeFixture(label: string, source: MutableSource): RuntimeFixture {
    const executed: Array<{ taskId: string; sourceSnapshots: unknown }> = [];
    const reader = createOfflineProductionReader(source);
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `production-source-integration-${label}`,
        now,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: reader as never,
        executeForTest: async request => {
            executed.push({ taskId: request.taskId, sourceSnapshots: request.sourceSnapshots });
            return `completed:${label}`;
        },
    });
    return { runtime, reader, executed };
}

async function admitWithDiscovery(
    fixture: RuntimeFixture,
    label: string,
    input: ReturnType<typeof discoveryInput> | ReturnType<typeof absenceInput>,
    requestMode: "normal" | "force" | "stale_only",
) {
    const firstEnumeration = input.sourceEnumerations[0]?.evidence;
    assert.ok(firstEnumeration, `${label} requires one source enumeration`);
    const admitted = await fixture.runtime.admit({
        kind: "record-batch-update",
        requestKey: `production-source-integration:${label}`,
        requestSummary: {
            operation: "record-batch-update",
            dataChain: "codex",
            workspaceHash: firstEnumeration.identity.workspace.workspaceId,
            label,
        },
        resumePayload: {
            kind: "record-batch-update",
            phase: "preparing",
            resumeKey: label,
            dataChain: "codex",
            modelChain: "codex",
            request: {},
        },
        requestMode,
        discovery: {
            kind: "record-batch-update",
            selector: requestMode,
            requestKey: `production-source-discovery:${label}`,
            workspaceHash: firstEnumeration.identity.workspace.workspaceId,
            workspacePath: firstEnumeration.identity.workspace.canonicalPath,
            hosts: ["codex"],
            input,
        },
        execute: async () => "legacy executor must not run in test mode",
    });
    assert.notEqual(admitted.outcome, "UnknownOutcome", `${label} admission must be durable`);
    if (admitted.outcome === "UnknownOutcome") throw new Error(`${label} unresolved admission: ${admitted.reasons.join("; ")}`);
    const status = await fixture.runtime.waitForTerminal(admitted.taskId, 5);
    return { admitted, status };
}

function currentLedger(taskId: string) {
    const stored = schedulerStore.readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: true });
    assert.equal(stored.kind, "current", `expected readable scheduler ledger ${taskId}`);
    if (stored.kind !== "current") throw new Error(`scheduler ledger ${taskId} is ${stored.kind}`);
    return stored.ledger;
}

async function currentConversationState(workspaceHash: string, conversationId: string) {
    const read = await stateStore.readRecordConversationStateStore({ dataRoot });
    assert.equal(read.kind, "current", `conversation-state must be current for ${conversationId}`);
    if (read.kind !== "current") throw new Error(`conversation-state is ${read.kind}`);
    const key = stateStore.canonicalConversationStateKey({ chain: "codex", workspaceHash, conversationId });
    const entry = read.index.entries[key];
    assert.ok(entry, `missing conversation-state entry for ${conversationId}`);
    return entry;
}

async function addPreparedCommit(taskId: string): Promise<PreparedGuardCommit> {
    const before = currentLedger(taskId);
    const ownerLease = before.schedulerOwner;
    assert.ok(ownerLease, `task ${taskId} requires a current scheduler owner lease before preparing a guarded commit`);
    const source = before.sourceSnapshots[0];
    assert.ok(source, `task ${taskId} requires a frozen source snapshot before source guard`);
    const recordWorkKey = workRegistry.recordWorkKey({
        chain: source.chain,
        workspaceHash: source.workspaceHash,
        conversationId: source.conversationId,
    }, source.desiredRevision);
    const unitId = `${taskId}-guard-unit`;
    const attemptId = `${taskId}-guard-attempt`;
    const commitId = `${taskId}-guard-commit`;
    const fence = {
        schedulerEpoch: ownerLease.schedulerEpoch,
        recordCommitEpoch: 1,
        fencingToken: ownerLease.fencingToken,
        workLeaseId: `${taskId}-guard-lease`,
    };
    const mutationNowMs = clockMs;
    await schedulerStore.mutateRecordSchedulerLedgerAsOwner(taskId, before.revision, ownerLease, ledger => {
        ledger.task.state = "Committing";
        delete ledger.task.terminalState;
        ledger.task.repairState = "None";
        ledger.task.recordItems = { total: 1, succeeded: 0, failed: 0, unresolved: 0 };
        ledger.task.units = { materialized: 1, eligible: 0, running: 0, done: 1, failed: 0 };
        ledger.recordWork = [{
            recordWorkKey,
            conversationId: source.conversationId,
            chain: source.chain,
            workspaceHash: source.workspaceHash,
            desiredRevision: source.desiredRevision,
            recordCommitEpoch: 1,
            registryRevision: 1,
            registryRef: source.snapshotRef,
            schedulerEpoch: ownerLease.schedulerEpoch,
            workLeaseId: fence.workLeaseId,
            leaseOwnerId: ownerLease.ownerId,
            leaseExpiresAt: new Date(mutationNowMs + 60_000).toISOString(),
            activeTaskIds: [taskId],
            currentFencingToken: ownerLease.fencingToken,
        }];
        ledger.units = [{
            unitId,
            taskId,
            recordId: source.conversationId,
            state: "Succeeded",
            layer: "record",
            splitDepth: 0,
            recordWorkKey,
            recordCommitEpoch: 1,
            dependencies: [],
            composeOrder: 0,
            sourceSnapshotId: source.sourceSnapshotId,
            inputHash: `${taskId}-guard-input`,
            estimatedCost: 1,
            routePlan: ["grok"],
            attemptedProviders: ["grok"],
            retryBudget: 1,
            enqueueTime: new Date(mutationNowMs).toISOString(),
            layerEnterTime: new Date(mutationNowMs).toISOString(),
            resultRef: source.contentRef,
            coveredRevision: source.desiredRevision,
            commitId,
        }];
        ledger.attempts = [{
            attemptId,
            unitId,
            recordWorkKey,
            originTaskIds: [taskId],
            activeTaskIds: [],
            state: "KnownSuccess",
            outcome: "known_success",
            provider: "grok",
            model: "grok-4.5",
            dispatchIntentAt: new Date(mutationNowMs).toISOString(),
            dispatchIntentLedgerRevision: ledger.revision,
            dispatchIntentRef: source.snapshotRef,
            startedAt: new Date(mutationNowMs).toISOString(),
            leaseExpiresAt: new Date(mutationNowMs + 60_000).toISOString(),
            inputHash: `${taskId}-guard-input`,
            outputRef: source.contentRef,
            elapsedMs: 1,
            fence,
        }];
        ledger.commits = [{
            schemaVersion: contracts.RECORD_SCHEDULER_SCHEMA_VERSION,
            commitId,
            taskId,
            unitId,
            attemptId,
            recordWorkKey,
            sourceSnapshotId: source.sourceSnapshotId,
            inputHash: `${taskId}-guard-input`,
            outputHash: source.contentRef.hash,
            qualityResult: { accepted: true },
            bodyRef: source.contentRef,
            bodyHash: source.contentRef.hash,
            ownership: { mode: "task_exclusive", ownerTaskId: taskId },
            coveredRevision: source.desiredRevision,
            observedSourceRevisionAtCommit: source.desiredRevision,
            state: "ResultReady",
            cleanupPhase: "NotRequired",
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
        }];
        ledger.task.updatedAt = new Date(mutationNowMs).toISOString();
    }, { nowMs: mutationNowMs });
    return { sourceSnapshotId: source.sourceSnapshotId, recordWorkKey, commitId };
}

async function guardSourceCommit(
    fixture: RuntimeFixture,
    taskId: string,
    prepared: PreparedGuardCommit,
) {
    return fixture.runtime.guardSourceCommit({
        taskId,
        sourceSnapshotId: prepared.sourceSnapshotId,
        recordWorkKey: prepared.recordWorkKey,
    });
}

async function testAdmittedDiscoveryPersistsFullReadIdentity(): Promise<void> {
    const workspaceHash = "production-admitted-workspace";
    const workspacePath = path.join(dataRoot, "production-admitted-workspace");
    const conversationId = "production-admitted-conversation";
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "production body v1", scanCalls: 0, scanSequence: 0 };
    const fixture = createRuntimeFixture("admitted", source);
    const admitted = await admitWithDiscovery(
        fixture,
        "admitted",
        discoveryInput({ workspaceHash, workspacePath, conversationId, revision: source.revision }),
        "normal",
    );
    assert.equal(
        admitted.status?.state,
        "Succeeded",
        JSON.stringify({ status: admitted.status, ledger: currentLedger(admitted.admitted.taskId) }),
    );
    assert.equal(source.scanCalls, 1, "admitted selected candidate must perform one full production source read");
    assert.equal(fixture.executed.length, 1);
    const ledger = currentLedger(admitted.admitted.taskId);
    const frozen = ledger.sourceSnapshots[0];
    assert.ok(frozen, "admitted discovery must freeze the source snapshot");
    const state = await currentConversationState(workspaceHash, conversationId);
    assert.ok(state.activeTaskIds.includes(admitted.admitted.taskId), "conversation-state must retain the scheduler taskId that admitted the source");
    assert.equal(state.latestObservedRevision, "revision-1");
    assert.equal(state.lastCompleteScanId, "production-reader-1");
    const fullReadEvidence = state.evidence.find(item => item.source === "record-source-full-read");
    assert.ok(fullReadEvidence, "conversation-state must retain full-read evidence rather than discovery-only evidence");
    assert.equal(fullReadEvidence.details?.contentHash, `sha256:${frozen.contentHash}`);
    assert.equal(fullReadEvidence.details?.sourceRevision, frozen.desiredRevision);
    assert.equal(frozen.desiredRevision, "revision-1");
}

async function testRestartSameRevisionDifferentBytesConflictsAndFailsClosed(): Promise<void> {
    const workspaceHash = "production-conflict-workspace";
    const workspacePath = path.join(dataRoot, "production-conflict-workspace");
    const conversationId = "production-conflict-conversation";
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "stable bytes", scanCalls: 0, scanSequence: 0 };
    const first = createRuntimeFixture("conflict-first", source);
    const input = discoveryInput({ workspaceHash, workspacePath, conversationId, revision: "revision-1" });
    const firstAdmission = await admitWithDiscovery(first, "conflict-first", input, "normal");
    assert.equal(firstAdmission.status?.state, "Succeeded");
    source.body = "different bytes with the same revision";
    const restarted = createRuntimeFixture("conflict-restarted", source);
    const secondAdmission = await admitWithDiscovery(restarted, "conflict-restarted", input, "normal");
    assert.equal(
        secondAdmission.status?.state,
        "RepairRequired",
        `second runtime must fail closed instead of accepting same-revision different bytes: ${JSON.stringify(secondAdmission.status)}`,
    );
    const state = await currentConversationState(workspaceHash, conversationId);
    assert.equal(state.state, "Conflict", JSON.stringify(state));
    assert.equal(state.stateReason, "same-revision-different-source-bytes");
    assert.ok(state.evidence.filter(item => item.source === "record-source-full-read").length >= 2);
}

async function testEmptyMaterializationMarkerAvoidsRestartSourceIo(): Promise<void> {
    const workspaceHash = "production-empty-marker-workspace";
    const workspacePath = path.join(dataRoot, "production-empty-marker-workspace");
    const conversationId = "production-empty-marker-conversation";
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "would be read only if selection were nonempty", scanCalls: 0, scanSequence: 0 };
    const fixture = createRuntimeFixture("empty-marker-first", source);
    const input = discoveryInput({
        workspaceHash,
        workspacePath,
        conversationId,
        revision: "revision-1",
        coveredRevision: "revision-1",
    });
    const admitted = await admitWithDiscovery(fixture, "empty-marker-first", input, "stale_only");
    assert.equal(admitted.status?.state, "Succeeded");
    assert.equal(source.scanCalls, 0, "empty selected set must persist its marker without source I/O");
    const restarted = createRuntimeFixture("empty-marker-restarted", source);
    await restarted.runtime.recover(admitted.admitted.taskId);
    assert.equal(source.scanCalls, 0, "restart recovery must consume the durable empty marker without another source read");
    const frozen = await restarted.runtime.readFrozenSources(admitted.admitted.taskId);
    assert.deepEqual(frozen.sources, []);
    assert.deepEqual(frozen.unresolved, []);
}

async function testLostBoundaryRequiresTwoIndependentScansAndOneHour(): Promise<void> {
    const workspaceHash = "production-lost-workspace";
    const workspacePath = path.join(dataRoot, "production-lost-workspace");
    const conversationId = "production-lost-conversation";
    const source: MutableSource = { revision: "unused", revisionSequence: 1, body: "unused", scanCalls: 0, scanSequence: 0 };
    const firstInput = absenceInput({
        workspaceHash,
        workspacePath,
        conversationId,
        scanId: "lost-scan-a",
        sequence: 1,
        completedAtMs: baseTimeMs,
    });
    const first = createRuntimeFixture("lost-first", source);
    const admitted = await admitWithDiscovery(first, "lost-first", firstInput, "normal");
    assert.equal(admitted.status?.state, "Deferred", "the first complete absence must remain source_unresolved until an independent recheck reaches the Lost boundary");
    const closeInput = absenceInput({
        workspaceHash,
        workspacePath,
        conversationId,
        scanId: "lost-scan-b-close",
        sequence: 2,
        completedAtMs: baseTimeMs + 60 * 60 * 1000 - 1,
    });
    const closeRuntime = createRuntimeFixture("lost-close", source);
    const closeSnapshot = await closeRuntime.runtime.discover({
        kind: "stale_check",
        selector: "stale_only",
        requestKey: "production-lost-close",
        workspaceHash,
        workspacePath,
        hosts: ["codex"],
        input: closeInput,
    });
    assert.equal(closeSnapshot.candidates[0]?.classification, "Unresolved", "two independent scans at 59m59.999s must remain Unresolved");
    assert.equal((await currentConversationState(workspaceHash, conversationId)).state, "Unresolved");
    const boundaryInput = absenceInput({
        workspaceHash,
        workspacePath,
        conversationId,
        scanId: "lost-scan-c-boundary",
        sequence: 3,
        completedAtMs: baseTimeMs + 60 * 60 * 1000,
    });
    const boundaryRuntime = createRuntimeFixture("lost-boundary", source);
    const boundarySnapshot = await boundaryRuntime.runtime.discover({
        kind: "stale_check",
        selector: "stale_only",
        requestKey: "production-lost-boundary",
        workspaceHash,
        workspacePath,
        hosts: ["codex"],
        input: boundaryInput,
    });
    assert.equal(boundarySnapshot.candidates[0]?.classification, "Lost", "exactly one hour after an independent scan may become Lost");
    assert.equal((await currentConversationState(workspaceHash, conversationId)).state, "Lost");
}

async function testExplicitAuthorityRebuildCannotReverseAuthorizeConflict(): Promise<void> {
    const workspaceHash = "production-rebuild-workspace";
    const workspacePath = path.join(dataRoot, "production-rebuild-workspace");
    const conversationId = "production-rebuild-conversation";
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "authoritative bytes A", scanCalls: 0, scanSequence: 0 };
    const input = discoveryInput({
        workspaceHash,
        workspacePath,
        conversationId,
        revision: "revision-1",
        coveredRevision: "revision-1",
    });
    const first = createRuntimeFixture("rebuild-first", source);
    const firstAdmission = await admitWithDiscovery(first, "rebuild-first", input, "force");
    assert.equal(firstAdmission.status?.state, "Succeeded");
    source.body = "authoritative bytes B at the unchanged revision";
    const conflicting = createRuntimeFixture("rebuild-conflict", source);
    const conflictAdmission = await admitWithDiscovery(conflicting, "rebuild-conflict", input, "force");
    assert.equal(conflictAdmission.status?.state, "RepairRequired");
    assert.equal((await currentConversationState(workspaceHash, conversationId)).state, "Conflict");
    fs.writeFileSync(stateStore.recordConversationStatePath({ dataRoot }), "{corrupt", "utf8");
    const rebuilt = createRuntimeFixture("rebuild-after-corruption", source);
    const rebuiltAdmission = await admitWithDiscovery(rebuilt, "rebuild-after-corruption", input, "force");
    assert.equal(rebuiltAdmission.status?.state, "RepairRequired", "explicit authority rebuild must not authorize a commit whose source still has same-revision different bytes");
    const state = await currentConversationState(workspaceHash, conversationId);
    assert.equal(state.state, "Conflict");
    assert.equal(rebuilt.executed.length, 0, "conflicted source must never reach test execution after authority rebuild");
}

async function testAdvancedSourceGuardPersistsStaleRefreshAndReadback(scenario = "base"): Promise<{ fixture: RuntimeFixture; taskId: string; prepared: PreparedGuardCommit; refreshKey: string; receiptPath: string; indexPath: string; source: MutableSource }> {
    const suffix = scenario === "base" ? "" : `-${scenario}`;
    const workspaceHash = `production-stale-workspace${suffix}`;
    const workspacePath = path.join(dataRoot, workspaceHash);
    const conversationId = `production-stale-conversation${suffix}`;
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "snapshot body", scanCalls: 0, scanSequence: 0 };
    const fixture = createRuntimeFixture(`stale-guard${suffix}`, source);
    const input = discoveryInput({
        workspaceHash,
        workspacePath,
        conversationId,
        revision: "revision-1",
        coveredRevision: "revision-1",
    });
    const admitted = await admitWithDiscovery(fixture, `stale-guard${suffix}`, input, "force");
    assert.equal(admitted.status?.state, "Succeeded");
    const prepared = await addPreparedCommit(admitted.admitted.taskId);
    source.revision = "revision-2";
    source.revisionSequence = 2;
    source.body = "newer source body";
    const decision = await guardSourceCommit(fixture, admitted.admitted.taskId, prepared);
    assert.equal(decision.commitAllowed, true, JSON.stringify({
        reason: decision.reason,
        candidateState: decision.candidateState,
        reread: decision.reread,
        refreshPersistence: decision.refreshPersistence,
    }));
    assert.equal(decision.candidateState, "Stale");
    assert.equal(decision.ledgerCommit?.coveredRevision, "revision-1");
    assert.equal(decision.conversationState.recordCoveredRevision, "revision-1");
    assert.equal(decision.conversationState.observedSourceRevision, "revision-2");
    assert.ok(decision.refreshPersistence);
    assert.equal(decision.refreshPersistence?.readBack.kind, "verified");
    assert.equal(decision.refreshPersistence?.readBack.readFrom, "durable-storage");
    const pendingRefresh = decision.ledgerCommit?.pendingRefresh;
    assert.ok(pendingRefresh, "advanced source guard must attach a pending refresh");
    const state = await currentConversationState(workspaceHash, conversationId);
    assert.equal(state.state, "Stale");
    assert.equal(state.recordCoveredRevision, "revision-1");
    assert.equal(state.latestObservedRevision, "revision-2");
    assert.equal(state.pendingRefreshKey, pendingRefresh.refreshKey);
    const persistedLedger = currentLedger(admitted.admitted.taskId);
    const persistedCommit = persistedLedger.commits.find(commit => commit.commitId === prepared.commitId);
    assert.equal(persistedCommit?.pendingRefresh?.refreshKey, pendingRefresh.refreshKey);
    const refreshDirectory = path.join(
        dataRoot,
        "record-recovery",
        "record-source-refresh",
        pendingRefresh.refreshKey.replace(/^sha256:/u, ""),
    );
    const indexFiles = fs.readdirSync(refreshDirectory, { withFileTypes: true })
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"));
    assert.equal(indexFiles.length, 1, "one source/work binding must publish exactly one immutable refresh attachment");
    const indexPath = path.join(refreshDirectory, indexFiles[0]!.name);
    const receiptPath = path.join(dataRoot, pendingRefresh.ledgerRef.path);
    assert.ok(fs.existsSync(indexPath));
    assert.ok(fs.existsSync(receiptPath));
    return { fixture, taskId: admitted.admitted.taskId, prepared, refreshKey: pendingRefresh.refreshKey, receiptPath, indexPath, source };
}

async function testProductionRevisionOrderingEqualBehindAndUnresolved(): Promise<void> {
    const cases = [
        { name: "equal", initialSequence: 1, revision: "revision-1", sequence: 1, body: "snapshot body", allowed: true, state: "Fresh", reason: "revision-and-content-equal" },
        { name: "behind", initialSequence: 2, revision: "revision-0", sequence: 1, body: "older source body", allowed: false, state: "Conflict", reason: "source-revision-moved-backward" },
        { name: "same-sequence-different-revision", initialSequence: 1, revision: "revision-2", sequence: 1, body: "ambiguous source body", allowed: false, state: "Unresolved", reason: "revision-ordering-unresolved" },
    ] as const;
    for (const entry of cases) {
        const workspaceHash = `production-revision-order-${entry.name}`;
        const workspacePath = path.join(dataRoot, workspaceHash);
        const conversationId = `production-revision-order-${entry.name}`;
        const source: MutableSource = { revision: "revision-1", revisionSequence: entry.initialSequence, body: "snapshot body", scanCalls: 0, scanSequence: 0 };
        const fixture = createRuntimeFixture(`revision-order-${entry.name}`, source);
        const input = discoveryInput({ workspaceHash, workspacePath, conversationId, revision: source.revision, coveredRevision: source.revision });
        const admitted = await admitWithDiscovery(fixture, `revision-order-${entry.name}`, input, "force");
        assert.equal(admitted.status?.state, "Succeeded");
        assert.equal(currentLedger(admitted.admitted.taskId).sourceSnapshots[0]?.sourceRevisionSequence, entry.initialSequence, "source snapshot must persist the authoritative revision sequence");
        const prepared = await addPreparedCommit(admitted.admitted.taskId);
        source.revision = entry.revision;
        source.revisionSequence = entry.sequence;
        source.body = entry.body;
        const decision = await guardSourceCommit(fixture, admitted.admitted.taskId, prepared);
        const detail = JSON.stringify({ reason: decision.reason, candidateState: decision.candidateState, reread: decision.reread });
        assert.equal(decision.commitAllowed, entry.allowed, `${entry.name}: ${detail}`);
        assert.equal(decision.candidateState, entry.state, `${entry.name}: ${detail}`);
        assert.equal(decision.reason, entry.reason, `${entry.name}: ${detail}`);
        if (!entry.allowed) assert.equal(decision.ledgerCommit, null, entry.name);
    }
}

async function testRefreshIndexAndReceiptCorruptionFailClosed(stale: Awaited<ReturnType<typeof testAdvancedSourceGuardPersistsStaleRefreshAndReadback>>): Promise<void> {
    const indexBytes = fs.readFileSync(stale.indexPath);
    fs.writeFileSync(stale.indexPath, "{bad refresh index", "utf8");
    const indexRuntime = createRuntimeFixture("corrupt-refresh-index", stale.source);
    const indexDecision = await guardSourceCommit(indexRuntime, stale.taskId, stale.prepared);
    assert.equal(indexDecision.commitAllowed, false, "corrupt refresh index must fail closed before any commit can proceed");
    assert.equal(indexDecision.candidateState, "Unresolved");
    assert.match(indexDecision.reason, /pending-refresh-ensure-failed:refresh index .*无法解析/u);
    assert.equal(indexDecision.ledgerCommit, null);
    fs.writeFileSync(stale.indexPath, indexBytes);
    const receiptStale = await testAdvancedSourceGuardPersistsStaleRefreshAndReadback("receipt-corruption");
    fs.writeFileSync(receiptStale.receiptPath, "bad refresh receipt", "utf8");
    const receiptRuntime = createRuntimeFixture("corrupt-refresh-receipt", receiptStale.source);
    const decision = await guardSourceCommit(receiptRuntime, receiptStale.taskId, receiptStale.prepared);
    assert.equal(decision.commitAllowed, false, "corrupt refresh receipt must remove commit authorization");
    assert.equal(decision.candidateState, "Unresolved");
    assert.equal(decision.reason, "pending-refresh-durability-receipt-invalid");
    assert.equal(decision.ledgerCommit, null);
}

async function testTwoRuntimesShareOneRefreshTaskId(): Promise<void> {
    const workspaceHash = "production-shared-refresh-workspace";
    const workspacePath = path.join(dataRoot, "production-shared-refresh-workspace");
    const conversationId = "production-shared-refresh-conversation";
    const source: MutableSource = { revision: "revision-1", revisionSequence: 1, body: "shared snapshot body", scanCalls: 0, scanSequence: 0 };
    const input = discoveryInput({
        workspaceHash,
        workspacePath,
        conversationId,
        revision: "revision-1",
        coveredRevision: "revision-1",
    });
    const first = createRuntimeFixture("shared-refresh-first", source);
    const second = createRuntimeFixture("shared-refresh-second", source);
    const firstAdmission = await admitWithDiscovery(first, "shared-refresh-first", input, "force");
    const secondAdmission = await admitWithDiscovery(second, "shared-refresh-second", input, "force");
    assert.equal(firstAdmission.status?.state, "Succeeded");
    assert.equal(secondAdmission.status?.state, "Succeeded");
    const firstPrepared = await addPreparedCommit(firstAdmission.admitted.taskId);
    const secondPrepared = await addPreparedCommit(secondAdmission.admitted.taskId);
    source.revision = "revision-2";
    source.revisionSequence = 2;
    source.body = "shared newer body";
    const [firstDecision, secondDecision] = await Promise.all([
        guardSourceCommit(first, firstAdmission.admitted.taskId, firstPrepared),
        guardSourceCommit(second, secondAdmission.admitted.taskId, secondPrepared),
    ]);
    assert.equal(firstDecision.candidateState, "Stale", JSON.stringify(firstDecision));
    assert.equal(secondDecision.candidateState, "Stale", JSON.stringify(secondDecision));
    const firstRefresh = firstDecision.ledgerCommit?.pendingRefresh;
    const secondRefresh = secondDecision.ledgerCommit?.pendingRefresh;
    assert.ok(firstRefresh);
    assert.ok(secondRefresh);
    assert.equal(firstRefresh.refreshKey, secondRefresh.refreshKey);
    assert.equal(firstRefresh.refreshTaskId, secondRefresh.refreshTaskId, "two runtimes handling the same refreshKey must share one durable refreshTaskId");
}

const tests: Array<[string, () => Promise<void>]> = [
    ["admitted discovery/full read persists taskId revision and content hash", testAdmittedDiscoveryPersistsFullReadIdentity],
    ["same revision with different bytes conflicts after restart", testRestartSameRevisionDifferentBytesConflictsAndFailsClosed],
    ["empty materialization marker prevents restart source I/O", testEmptyMaterializationMarkerAvoidsRestartSourceIo],
    ["Lost boundary waits for independent scans and one hour", testLostBoundaryRequiresTwoIndependentScansAndOneHour],
    ["conversation-state authority rebuild cannot reverse authorize conflict", testExplicitAuthorityRebuildCannotReverseAuthorizeConflict],
    ["production revision ordering handles equal behind and unresolved", testProductionRevisionOrderingEqualBehindAndUnresolved],
    ["two runtimes share one durable refresh task id", testTwoRuntimesShareOneRefreshTaskId],
];

const failures: Array<{ name: string; error: unknown }> = [];
try {
    for (const [name, test] of tests) {
        try {
            await test();
            process.stdout.write(`PASS ${name}\n`);
        } catch (error) {
            failures.push({ name, error });
            process.stderr.write(`FAIL ${name}: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
        }
    }
    let stale: Awaited<ReturnType<typeof testAdvancedSourceGuardPersistsStaleRefreshAndReadback>> | undefined;
    try {
        stale = await testAdvancedSourceGuardPersistsStaleRefreshAndReadback();
        process.stdout.write("PASS advanced source guard persists stale refresh and readback\n");
    } catch (error) {
        failures.push({ name: "advanced source guard persists stale refresh and readback", error });
        process.stderr.write(`FAIL advanced source guard persists stale refresh and readback: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    }
    if (stale) {
        try {
            await testRefreshIndexAndReceiptCorruptionFailClosed(stale);
            process.stdout.write("PASS refresh index and receipt corruption fail closed\n");
        } catch (error) {
            failures.push({ name: "refresh index and receipt corruption fail closed", error });
            process.stderr.write(`FAIL refresh index and receipt corruption fail closed: ${error instanceof Error ? error.stack || error.message : String(error)}\n`);
        }
    }
    if (failures.length > 0) {
        throw new AggregateError(failures.map(item => item.error), `${failures.length} production source runtime integration assertion(s) failed: ${failures.map(item => item.name).join("; ")}`);
    }
} finally {
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
