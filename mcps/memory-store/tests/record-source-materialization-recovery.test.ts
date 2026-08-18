import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-source-materialization-recovery-"));
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
const backgroundTasks = await import("../src/background-tasks.ts");

const baseTimeMs = Date.parse("2026-07-14T00:00:00.000Z");

type SourceDisposition = "accepted" | "unresolved";

interface SourceFixture {
    id: string;
    workspaceHash: string;
    workspacePath: string;
    conversationId: string;
    revision: string;
    revisionSequence: number;
    body: string;
    disposition: SourceDisposition;
    scanCalls: number;
}

interface ExecutionObservation {
    sourceIds: string[];
    unresolvedConversationIds: string[];
}

interface ReaderFixture {
    reader: unknown;
    releaseBlockedRead: () => void;
    waitForBlockedRead: () => Promise<void>;
}

interface RuntimeFixture {
    runtime: InstanceType<typeof runtimeModule.RecordSchedulerRuntime>;
    executions: ExecutionObservation[];
}

function sha256(value: Uint8Array | string): string {
    return createHash("sha256").update(value).digest("hex");
}

function timestamp(offsetMs = 0): string {
    return new Date(baseTimeMs + offsetMs).toISOString();
}

function sourceIdentity(source: SourceFixture) {
    return {
        host: "codex" as const,
        identity: {
            workspace: { workspaceId: source.workspaceHash, canonicalPath: source.workspacePath },
            source: {
                kind: "filesystem" as const,
                authority: `${source.workspacePath}/authority`,
                authoritativeRoot: `${source.workspacePath}/authority`,
                canonicalPath: `${source.workspacePath}/source`,
            },
            conversationId: source.conversationId,
        },
    };
}

function sourceEnumeration(source: SourceFixture, suffix = "discovery") {
    const identity = sourceIdentity(source);
    return evidence.buildSourceEnumerationEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: "codex",
        identity: identity.identity,
        sourceRevision: {
            revision: source.revision,
            contentCursor: `cursor-${source.id}-${source.revision}`,
            eventWatermark: `watermark-${source.id}-${source.revision}`,
            sequence: source.revisionSequence,
        },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: {
            scanId: `${suffix}-${source.id}`,
            sequence: source.revisionSequence,
            startedAt: timestamp(source.revisionSequence * 10),
            completedAt: timestamp(source.revisionSequence * 10 + 1),
        },
        targetStatus: "present",
    });
}

function exactFetch(enumeration: ReturnType<typeof sourceEnumeration>) {
    return evidence.buildExactFetchEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: enumeration.host,
        identity: enumeration.identity,
        sourceRevision: enumeration.sourceRevision,
        pagination: enumeration.pagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: enumeration.observedAt,
    });
}

function discoveryInput(label: string, sources: readonly SourceFixture[]) {
    const scopes = sources.map(source => discovery.buildRecordIndexScope({
        workspace: sourceIdentity(source).identity.workspace,
        snapshotId: `index-${label}-${source.id}`,
        indexRevision: `index-revision-${label}`,
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    }));
    return {
        request: {
            snapshotId: `snapshot-${label}`,
            discoveredAtSequence: 1,
            filters: { hosts: ["codex"], workspace: sources[0]?.workspacePath || null, extensions: {} },
        },
        sourceEnumerations: sources.map(source => ({
            evidence: sourceEnumeration(source),
            revisionSequence: source.revisionSequence,
            title: source.conversationId,
        })),
        recordIndex: {
            scopes,
            entries: sources.map((source, index) => discovery.buildRecordIndexEntry({
                recordId: `record-${label}-${source.id}`,
                source: sourceIdentity(source),
                indexSnapshotId: scopes[index]!.snapshotId,
                indexRevision: scopes[index]!.indexRevision,
                coveredRevision: { revision: `covered-before-${source.id}`, sequence: 0 },
                recordBodyHash: `sha256:${sha256(`record-${label}-${source.id}`)}`,
                extensions: {},
            })),
        },
        absenceObservations: [],
    };
}

function completeScan(source: SourceFixture) {
    const identity = sourceIdentity(source);
    const enumeration = sourceEnumeration(source, "production-enumeration");
    const exact = exactFetch(enumeration);
    const document = {
        schemaVersion: production.PRODUCTION_SOURCE_CONTENT_SCHEMA_VERSION,
        formatterVersion: production.PRODUCTION_SOURCE_FORMATTER_VERSION,
        source: { host: "codex" as const, conversationId: source.conversationId },
        messages: [
            { order: 1, role: "user" as const, content: `source ${source.revision}` },
            { order: 2, role: "assistant" as const, content: source.body },
        ],
    };
    const bytes = Buffer.from(JSON.stringify(document), "utf8");
    const contentHash = `sha256:${sha256(bytes)}`;
    const fullReadEvidence = evidence.buildFullSourceReadEvidence({
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
            scanId: `production-full-${source.id}`,
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
    return {
        host: "codex" as const,
        scanId: `production-scan-${source.id}`,
        enumeration,
        exactFetch: exact,
        fullSourceRead: {
            status: "complete" as const,
            evidence: fullReadEvidence,
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
                exactFetchEvidenceHash: exact.evidenceHash,
                fullReadEvidenceHash: fullReadEvidence.evidenceHash,
            },
            issues: [],
        },
        sourceSnapshot: null,
        classification: { state: "Present" as const, reason: "fixture-present" },
        qualifiedAbsence: null,
    };
}

function unresolvedScan(source: SourceFixture) {
    const identity = sourceIdentity(source);
    const enumeration = sourceEnumeration(source, "production-enumeration");
    const exact = exactFetch(enumeration);
    return {
        host: "codex" as const,
        scanId: `production-scan-${source.id}`,
        enumeration,
        exactFetch: exact,
        fullSourceRead: {
            status: "unresolved" as const,
            evidence: null,
            payload: null,
            sourceSnapshot: null,
            authority: {
                identityHash: sha256(JSON.stringify(identity.identity)),
                revisionHash: sha256(source.revision),
                identityStable: true,
                revisionStable: true,
                cacheBypassed: true,
                enumerationEvidenceHash: enumeration.evidenceHash,
                exactFetchEvidenceHash: exact.evidenceHash,
                fullReadEvidenceHash: null,
            },
            issues: [{ code: "source_unavailable", message: `fixture unresolved source ${source.conversationId}` }],
        },
        sourceSnapshot: null,
        classification: { state: "Unresolved" as const, reason: "fixture-unresolved" },
        qualifiedAbsence: null,
    };
}

function createReader(sources: readonly SourceFixture[], blockedConversationId?: string): ReaderFixture {
    const sourceByConversation = new Map(sources.map(source => [source.conversationId, source]));
    let blocked = false;
    let releaseBlockedRead = () => undefined;
    const blockedRead = new Promise<void>(resolve => {
        releaseBlockedRead = resolve;
    });
    let signalBlockedReadStarted!: () => void;
    const blockedReadStartPromise = new Promise<void>(resolve => {
        signalBlockedReadStarted = resolve;
    });
    return {
        reader: {
            scan: async (request: { conversationId: string }) => {
                const source = sourceByConversation.get(request.conversationId);
                if (!source) throw new Error(`unexpected fixture source read: ${request.conversationId}`);
                source.scanCalls += 1;
                if (!blocked && request.conversationId === blockedConversationId) {
                    blocked = true;
                    signalBlockedReadStarted();
                    await blockedRead;
                }
                return source.disposition === "accepted" ? completeScan(source) : unresolvedScan(source);
            },
        } as never,
        releaseBlockedRead,
        waitForBlockedRead: () => blockedReadStartPromise,
    };
}

function createRuntimeFixture(label: string, reader: unknown): RuntimeFixture {
    const executions: ExecutionObservation[] = [];
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-source-materialization-recovery-${label}`,
        now: () => new Date(baseTimeMs),
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: reader as never,
        executeForTest: async request => {
            executions.push({
                sourceIds: request.sourceSnapshots?.sources.map(source => source.snapshot.conversationId) || [],
                unresolvedConversationIds: request.sourceSnapshots?.unresolved.map(source => source.conversationId) || [],
            });
            return `executed:${label}`;
        },
    });
    return { runtime, executions };
}

function admitRequest(label: string, input: ReturnType<typeof discoveryInput>) {
    const first = input.sourceEnumerations[0]!.evidence.identity.workspace;
    return {
        kind: "record-batch-update" as const,
        requestKey: `record-source-materialization-recovery:${label}`,
        requestSummary: {
            operation: "record-batch-update",
            label,
            workspaceHash: first.workspaceId,
            dataChain: "codex",
            modelChain: "codex",
        },
        resumePayload: {
            kind: "record-batch-update",
            phase: "preparing",
            resumeKey: label,
            dataChain: "codex",
            modelChain: "codex",
            request: {},
        },
        requestMode: "normal" as const,
        discovery: {
            kind: "record-batch-update" as const,
            selector: "normal" as const,
            requestKey: `record-source-materialization-recovery-discovery:${label}`,
            workspaceHash: first.workspaceId,
            workspacePath: first.canonicalPath,
            hosts: ["codex" as const],
            input,
        },
        execute: async () => "legacy executor must not run in test mode",
    };
}

async function admitOrThrow(
    fixture: RuntimeFixture,
    label: string,
    input: ReturnType<typeof discoveryInput>,
) {
    const request = admitRequest(label, input);
    const admitted = await fixture.runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome", `${label} admission must persist a scheduler ledger`);
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    return { admitted, request };
}

function currentLedger(taskId: string) {
    const stored = schedulerStore.readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: true });
    assert.equal(stored.kind, "current", `scheduler ledger ${taskId} must be readable`);
    if (stored.kind !== "current") throw new Error(`scheduler ledger ${taskId} is ${stored.kind}`);
    return stored.ledger;
}

async function currentConversationState(workspaceHash: string, conversationId: string) {
    const read = await stateStore.readRecordConversationStateStore({ dataRoot });
    assert.equal(read.kind, "current", `conversation-state must be readable for ${conversationId}`);
    if (read.kind !== "current") throw new Error(`conversation-state is ${read.kind}`);
    const key = stateStore.canonicalConversationStateKey({ chain: "codex", workspaceHash, conversationId });
    const entry = read.index.entries[key];
    assert.ok(entry, `conversation-state entry missing for ${conversationId}`);
    return entry;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

function fixtureSource(label: string, options: Partial<Pick<SourceFixture, "body" | "disposition" | "revision" | "workspaceHash" | "workspacePath">> = {}): SourceFixture {
    return {
        id: label,
        workspaceHash: options.workspaceHash || `workspace-${label}`,
        workspacePath: options.workspacePath || path.join(dataRoot, "workspaces", label),
        conversationId: `conversation-${label}`,
        revision: options.revision || "revision-1",
        revisionSequence: 1,
        body: options.body || `body-${label}`,
        disposition: options.disposition || "accepted",
        scanCalls: 0,
    };
}

async function testAllSelectedUnresolvedDefersWithoutExecutor(): Promise<void> {
    const sources = [
        fixtureSource("all-unresolved-a", { disposition: "unresolved" }),
        fixtureSource("all-unresolved-b", { disposition: "unresolved" }),
    ];
    const input = discoveryInput("all-unresolved", sources);
    assert.deepEqual(discovery.discoverRecordCandidates(input).candidates.map(candidate => candidate.classification), ["Stale", "Stale"]);
    const reader = createReader(sources);
    const fixture = createRuntimeFixture("all-unresolved", reader.reader);
    const { admitted } = await admitOrThrow(fixture, "all-unresolved", input);
    const status = await fixture.runtime.waitForTerminal(admitted.taskId, 5);
    assert.equal(status?.state, "Deferred", JSON.stringify({ status, backgroundError: backgroundTasks.getBackgroundTask(admitted.taskId)?.error }));
    assert.equal(fixture.executions.length, 0, "no model/executor call is safe when every selected source is unresolved");
    assert.deepEqual(sources.map(source => source.scanCalls), [1, 1]);
    const materialization = currentLedger(admitted.taskId).sourceMaterialization;
    assert.equal(materialization?.phase, "sealed");
    assert.deepEqual(materialization?.outcomes.map(outcome => outcome.kind), ["unresolved", "unresolved"]);
}

async function testPartialAcceptedAndUnresolvedExecutesOnlySafeSources(): Promise<void> {
    const accepted = fixtureSource("partial-safe-accepted", { body: "safe source bytes" });
    const unresolved = fixtureSource("partial-safe-unresolved", { disposition: "unresolved" });
    const input = discoveryInput("partial-safe", [accepted, unresolved]);
    const reader = createReader([accepted, unresolved]);
    const fixture = createRuntimeFixture("partial-safe", reader.reader);
    const { admitted } = await admitOrThrow(fixture, "partial-safe", input);
    const status = await fixture.runtime.waitForTerminal(admitted.taskId, 5);
    assert.equal(status?.state, "Deferred", JSON.stringify({ status, backgroundError: backgroundTasks.getBackgroundTask(admitted.taskId)?.error }));
    assert.deepEqual(fixture.executions, [{
        sourceIds: [accepted.conversationId],
        unresolvedConversationIds: [unresolved.conversationId],
    }], "executor must receive only the materialized safe source");
    const outcomes = currentLedger(admitted.taskId).sourceMaterialization?.outcomes || [];
    assert.deepEqual(outcomes.map(outcome => outcome.kind).sort(), ["accepted", "unresolved"]);
}

async function testTamperedSealedMarkerRejectsRecoveryAsRepairRequired(): Promise<void> {
    const source = fixtureSource("tampered-marker", { body: "marker integrity source" });
    const input = discoveryInput("tampered-marker", [source]);
    const reader = createReader([source]);
    const fixture = createRuntimeFixture("tampered-marker", reader.reader);
    const { admitted } = await admitOrThrow(fixture, "tampered-marker", input);
    assert.equal((await fixture.runtime.waitForTerminal(admitted.taskId, 5))?.state, "Succeeded");
    const marker = currentLedger(admitted.taskId).sourceMaterialization?.markerRef;
    assert.ok(marker, "successful materialization must retain a durable seal marker");
    fs.writeFileSync(path.resolve(dataRoot, marker.path), "tampered sealed marker", "utf8");
    await assert.rejects(
        () => fixture.runtime.recover(admitted.taskId),
        error => error instanceof runtimeModule.RecordSchedulerRepairRequiredError
            && error.code === "SCHEDULER_REPAIR_REQUIRED",
        "recovery must treat a marker/ledger binding mismatch as RepairRequired",
    );
}

async function testIntentRecoveryNeverRereadsChangedLiveSource(): Promise<void> {
    const source = fixtureSource("intent-recovery-r1", { body: "frozen R1 source", revision: "R1" });
    const input = discoveryInput("intent-recovery-r1", [source]);
    const initialReader = createReader([source], source.conversationId);
    const initial = createRuntimeFixture("intent-recovery-initial", initialReader.reader);
    const { admitted, request } = await admitOrThrow(initial, "intent-recovery-r1", input);
    await initialReader.waitForBlockedRead();
    await waitUntil(() => {
        const ledger = currentLedger(admitted.taskId);
        return ledger.sourceMaterialization?.phase === "intent" && ledger.sourceMaterialization.outcomes.length === 0;
    }, "source materialization intent was not persisted before simulated recovery");

    source.revision = "R2";
    source.revisionSequence = 2;
    source.body = "live R2 source must never enter the recovered task";
    let resumedReaderCalls = 0;
    const resumed = createRuntimeFixture("intent-recovery-resumed", {
        scan: async () => {
            resumedReaderCalls += 1;
            return completeScan(source);
        },
    });
    const beforeTakeover = currentLedger(admitted.taskId);
    const resumedOwnerId = "record-source-materialization-recovery-intent-recovery-resumed";
    const takeover = await schedulerStore.claimSchedulerOwnerLease(
        admitted.taskId,
        beforeTakeover.revision,
        resumedOwnerId,
        { leaseMs: 30_000, nowMs: Date.now() + 60_000 },
    );
    await schedulerStore.completeSchedulerOwnerRecovery(
        admitted.taskId,
        takeover.revision,
        takeover.ownerLease,
        { recoveredRecordWorkKeys: [] },
    );
    const { execute: _execute, ...descriptor } = request;
    void _execute;
    let executedSourceIds: string[] | undefined;
    try {
        const result = await resumed.runtime.resumeExecution(
            admitted.taskId,
            { taskId: admitted.taskId, isCancelled: () => false, isSettled: () => false } as never,
            async (_context, _snapshot, frozenSources) => {
                executedSourceIds = frozenSources?.sources.map(item => item.snapshot.conversationId) || [];
                return "recovered-without-live-reread";
            },
            descriptor,
        );
        assert.equal(result?.kind, "settled");
        assert.equal(result?.status.state, "Deferred");
        assert.equal(resumedReaderCalls, 0, "recovery must not reread a changed source after CandidateSnapshot freeze");
        assert.equal(executedSourceIds, undefined, "all-unresolved recovery must not invoke execution with live R2 evidence");
        const outcome = currentLedger(admitted.taskId).sourceMaterialization?.outcomes[0];
        assert.equal(outcome?.kind, "unresolved");
        assert.equal(outcome?.sourceRevision, "R1");
        assert.match(outcome?.reason || "", /refused live reread/u);
    } finally {
        initialReader.releaseBlockedRead();
        await waitUntil(
            () => backgroundTasks.getBackgroundTask(admitted.taskId)?.status !== "running",
            "fenced initial worker did not settle after releasing its stale source read",
        );
    }
}

async function testFrozenSelectionLimitMaterializesOnlySelectedSources(): Promise<void> {
    const sources = Array.from({ length: 15 }, (_, index) => fixtureSource(`selection-limit-${String(index + 1).padStart(2, "0")}`));
    const input = discoveryInput("selection-limit", sources);
    const reader = createReader(sources);
    const fixture = createRuntimeFixture("selection-limit", reader.reader);
    const request = admitRequest("selection-limit", input);
    const admitted = await fixture.runtime.admit({
        ...request,
        discovery: { ...request.discovery, selectionLimit: 10 },
    });
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const status = await fixture.runtime.waitForTerminal(admitted.taskId, 30);
    assert.equal(status?.state, "Succeeded", JSON.stringify({ status, background: backgroundTasks.getBackgroundTask(admitted.taskId) }));
    const ledger = currentLedger(admitted.taskId);
    assert.equal(ledger.candidateSnapshot.candidates.length, 15, "classification scope must retain every eligible candidate before the final limit");
    assert.equal(ledger.candidateSnapshot.selectionLimit, 10);
    assert.equal(ledger.sourceMaterialization?.selected.length, 10);
    assert.equal(ledger.sourceMaterialization?.outcomes.length, 10);
    assert.equal(sources.reduce((total, source) => total + source.scanCalls, 0), 10, "only selected sources may be fully materialized");
    assert.equal(fixture.executions[0]?.sourceIds.length, 10);
}

async function testConflictOutcomeRebuildsConversationStateAfterCorruption(): Promise<void> {
    const workspaceHash = "conflict-rebuild-workspace";
    const workspacePath = path.join(dataRoot, workspaceHash);
    const firstSource = fixtureSource("conflict-rebuild", { workspaceHash, workspacePath, body: "same revision bytes A" });
    const firstInput = discoveryInput("conflict-rebuild-first", [firstSource]);
    const firstReader = createReader([firstSource]);
    const first = createRuntimeFixture("conflict-rebuild-first", firstReader.reader);
    const firstAdmission = await admitOrThrow(first, "conflict-rebuild-first", firstInput);
    assert.equal((await first.runtime.waitForTerminal(firstAdmission.admitted.taskId, 5))?.state, "Succeeded");

    const conflictingSource = { ...firstSource, body: "same revision bytes B", scanCalls: 0 };
    const conflictingInput = discoveryInput("conflict-rebuild-second", [conflictingSource]);
    const conflictingReader = createReader([conflictingSource]);
    const conflicting = createRuntimeFixture("conflict-rebuild-second", conflictingReader.reader);
    const conflictAdmission = await admitOrThrow(conflicting, "conflict-rebuild-second", conflictingInput);
    await conflicting.runtime.waitForTerminal(conflictAdmission.admitted.taskId, 5);
    const conflictLedger = currentLedger(conflictAdmission.admitted.taskId);
    assert.equal(conflictLedger.sourceMaterialization?.outcomes[0]?.kind, "conflict", "ledger must retain the conflict outcome as rebuild authority");

    fs.writeFileSync(stateStore.recordConversationStatePath({ dataRoot }), "{corrupt", "utf8");
    const rebuildRuntime = createRuntimeFixture("conflict-rebuild-after-corruption", createReader([conflictingSource]).reader);
    await rebuildRuntime.runtime.readFrozenSources(conflictAdmission.admitted.taskId);
    const rebuiltState = await currentConversationState(workspaceHash, firstSource.conversationId);
    assert.equal(rebuiltState.state, "Conflict", JSON.stringify(rebuiltState));
    assert.ok(rebuiltState.evidence.some(item => item.source === "scheduler-source-conflict-observation"));
}

async function testSameRevisionSameBytesStateRebuildAvoidsFalseConflict(): Promise<void> {
    const workspaceHash = "same-bytes-rebuild-workspace";
    const workspacePath = path.join(dataRoot, workspaceHash);
    const firstSource = fixtureSource("same-bytes-rebuild", { workspaceHash, workspacePath, body: "identical source bytes" });
    const firstInput = discoveryInput("same-bytes-rebuild-first", [firstSource]);
    const first = createRuntimeFixture("same-bytes-rebuild-first", createReader([firstSource]).reader);
    const firstAdmission = await admitOrThrow(first, "same-bytes-rebuild-first", firstInput);
    assert.equal((await first.runtime.waitForTerminal(firstAdmission.admitted.taskId, 5))?.state, "Succeeded");

    fs.writeFileSync(stateStore.recordConversationStatePath({ dataRoot }), "{corrupt", "utf8");
    const rebuildRuntime = createRuntimeFixture("same-bytes-rebuild-state", createReader([firstSource]).reader);
    await rebuildRuntime.runtime.readFrozenSources(firstAdmission.admitted.taskId);
    assert.notEqual((await currentConversationState(workspaceHash, firstSource.conversationId)).state, "Conflict");

    const repeatedSource = { ...firstSource, scanCalls: 0 };
    const repeatedInput = discoveryInput("same-bytes-rebuild-repeat", [repeatedSource]);
    const repeated = createRuntimeFixture("same-bytes-rebuild-repeat", createReader([repeatedSource]).reader);
    const repeatedAdmission = await admitOrThrow(repeated, "same-bytes-rebuild-repeat", repeatedInput);
    assert.equal((await repeated.runtime.waitForTerminal(repeatedAdmission.admitted.taskId, 5))?.state, "Succeeded");
    assert.equal(currentLedger(repeatedAdmission.admitted.taskId).sourceMaterialization?.outcomes[0]?.kind, "accepted");
    assert.notEqual((await currentConversationState(workspaceHash, firstSource.conversationId)).state, "Conflict");
}

const tests: Array<[string, () => Promise<void>]> = [
    ["all unresolved selected sources defer without executor", testAllSelectedUnresolvedDefersWithoutExecutor],
    ["partial materialization executes only safe sources then defers", testPartialAcceptedAndUnresolvedExecutesOnlySafeSources],
    ["tampered sealed marker rejects recovery as RepairRequired", testTamperedSealedMarkerRejectsRecoveryAsRepairRequired],
    ["intent recovery never rereads changed live source", testIntentRecoveryNeverRereadsChangedLiveSource],
    ["frozen selection limit materializes only selected sources", testFrozenSelectionLimitMaterializesOnlySelectedSources],
    ["ledger conflict outcome rebuilds Conflict after state corruption", testConflictOutcomeRebuildsConversationStateAfterCorruption],
    ["same revision and bytes survive state rebuild without false Conflict", testSameRevisionSameBytesStateRebuildAvoidsFalseConflict],
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
    if (failures.length > 0) {
        throw new AggregateError(failures.map(item => item.error), `${failures.length} source materialization recovery assertion(s) failed: ${failures.map(item => item.name).join("; ")}`);
    }
} finally {
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
