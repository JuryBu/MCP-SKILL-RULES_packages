import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-record-scheduler-runtime-resume-"));
const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const discovery = await import("../src/record-discovery.ts");
const backgroundTasks = await import("../src/background-tasks.ts");
const backgroundTaskSuspension = await import("../src/background-task-suspension.ts");
const evidence = await import("../src/source-evidence-contracts.ts");
const production = await import("../src/record-production-source-readers.ts");
const runtimeModule = await import("../src/record-scheduler-runtime.ts");
const controlModule = await import("../src/record-scheduler-control.ts");
const schedulerStore = await import("../src/record-scheduler-store.ts");
const sourceCache = await import("../src/conversation-source-cache.ts");

const suiteWallClockStartedAtMs = Date.now();
const baseTimeMs = suiteWallClockStartedAtMs;

function testNow(): Date {
    return new Date(baseTimeMs + (Date.now() - suiteWallClockStartedAtMs));
}

interface SourceFixture {
    id: string;
    workspaceHash: string;
    workspacePath: string;
    conversationId: string;
    body: string;
    revision: string;
    revisionSequence: number;
    disposition: "accepted" | "unresolved";
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

function absentFallbackEnumeration(source: SourceFixture, scanId: string, observedAt: string) {
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
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: { scanId, sequence: source.revisionSequence, startedAt: observedAt, completedAt: observedAt },
        targetStatus: "absent",
    });
}

function absentFallbackExactFetch(enumeration: ReturnType<typeof absentFallbackEnumeration>) {
    return evidence.buildExactFetchEvidence({
        adapterVersion: evidence.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: enumeration.host,
        identity: enumeration.identity,
        sourceRevision: enumeration.sourceRevision,
        pagination: enumeration.pagination,
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "not_found",
        errors: [],
        warnings: [],
        observedAt: enumeration.observedAt,
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

function discoveryInput(label: string, sources: readonly SourceFixture[], withCoveredRevision = true) {
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
                coveredRevision: withCoveredRevision
                    ? { revision: `covered-before-${source.id}`, sequence: 0 }
                    : null,
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

function createSource(label: string, disposition: SourceFixture["disposition"] = "accepted"): SourceFixture {
    return {
        id: label,
        workspaceHash: `workspace-${label}`,
        workspacePath: path.join(dataRoot, "workspaces", label),
        conversationId: `conversation-${label}`,
        body: `frozen source body ${label}`,
        revision: "revision-1",
        revisionSequence: 1,
        disposition,
    };
}

function sourceReader(sources: readonly SourceFixture[]) {
    const byConversation = new Map(sources.map(source => [source.conversationId, source]));
    return {
        scan: async (request: { conversationId: string }) => {
            const source = byConversation.get(request.conversationId);
            if (!source) throw new Error(`unexpected fixture source read: ${request.conversationId}`);
            return source.disposition === "accepted" ? completeScan(source) : unresolvedScan(source);
        },
    } as never;
}

function currentLedger(taskId: string) {
    const stored = schedulerStore.readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: true });
    assert.equal(stored.kind, "current", `scheduler ledger ${taskId} must be readable`);
    if (stored.kind !== "current") throw new Error(`scheduler ledger ${taskId} is ${stored.kind}`);
    return stored.ledger;
}

function snapshotFileEvidence(root: string): Record<string, string> {
    const snapshot: Record<string, string> = {};
    const visit = (directory: string) => {
        if (!fs.existsSync(directory)) return;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
            const absolutePath = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                visit(absolutePath);
            } else if (entry.isFile()) {
                snapshot[path.relative(root, absolutePath).replaceAll("\\", "/")] = sha256(fs.readFileSync(absolutePath));
            }
        }
    };
    visit(root);
    return snapshot;
}

async function setRecoverableState(taskId: string, state: "Queued" | "Running" | "Committing" | "CancelRequested" | "Cancelling"): Promise<void> {
    const ledger = currentLedger(taskId);
    const mutate = (candidate: typeof ledger) => {
        candidate.task.state = state;
        delete (candidate.task as { terminalState?: unknown }).terminalState;
        if (candidate.task.sourceResolution?.phase === "deferred") {
            candidate.task.sourceResolution.phase = "materialized";
            delete candidate.task.sourceResolution.deferredReason;
        }
        candidate.task.updatedAt = timestamp(10_000);
    };
    if (ledger.schedulerOwner) {
        await schedulerStore.mutateRecordSchedulerLedgerAsOwner(taskId, ledger.revision, ledger.schedulerOwner, mutate);
    } else {
        await schedulerStore.mutateRecordSchedulerLedger(taskId, ledger.revision, mutate);
    }
}

function resumeContext(taskId: string) {
    return {
        taskId,
        isCancelled: () => false,
        isSettled: () => false,
    } as never;
}

function restartedRuntime(label: string) {
    let liveCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            liveCalls += 1;
            throw new Error("resume must not re-enumerate live discovery");
        },
        productionSourceReader: {
            scan: async () => {
                liveCalls += 1;
                throw new Error("resume must not re-read live source");
            },
        } as never,
    });
    return { runtime, liveCalls: () => liveCalls };
}

function admissionRequest(
    label: string,
    sources: readonly SourceFixture[],
    input?: ReturnType<typeof discoveryInput>,
) {
    return {
        kind: "record-batch-update" as const,
        requestKey: `record-scheduler-runtime-resume:${label}`,
        requestSummary: { operation: "record-batch-update", label, workspaceHash: sources[0]!.workspaceHash, dataChain: "codex" },
        resumePayload: { kind: "record-batch-update", phase: "preparing", resumeKey: label, dataChain: "codex", modelChain: "codex", request: {} },
        requestMode: "normal" as const,
        discovery: {
            kind: "record-batch-update" as const,
            selector: "normal" as const,
            requestKey: `record-scheduler-runtime-resume-discovery:${label}`,
            workspaceHash: sources[0]!.workspaceHash,
            workspacePath: sources[0]!.workspacePath,
            hosts: ["codex" as const],
            ...(input ? { input } : {}),
        },
        execute: async () => "test mode must use executeForTest",
    };
}

function recoveryDescriptor(request: ReturnType<typeof admissionRequest>) {
    const { execute: _execute, ...descriptor } = request;
    void _execute;
    return descriptor;
}

async function waitUntil(predicate: () => boolean, message: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!predicate()) {
        if (Date.now() >= deadline) throw new Error(message);
        await new Promise(resolve => setTimeout(resolve, 10));
    }
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForBackgroundTaskSettlement(taskId: string) {
    const deadline = Date.now() + 15_000;
    while (true) {
        const task = backgroundTasks.getBackgroundTask(taskId);
        if (task && task.status !== "running") {
            await waitForBackgroundQueueIdle();
            return task;
        }
        if (Date.now() >= deadline) {
            throw new Error(`background task ${taskId} did not settle after releasing its crash gate`);
        }
        await delay(10);
    }
}

async function waitForBackgroundQueueIdle(): Promise<void> {
    const deadline = Date.now() + 15_000;
    while (true) {
        const stats = backgroundTasks.getBackgroundTaskQueueStatsForTest();
        if (stats.active === 0 && stats.pending === 0) return;
        if (Date.now() >= deadline) {
            throw new Error(`background task queue remained open: active=${stats.active} pending=${stats.pending}`);
        }
        await delay(10);
    }
}

async function sealedTask(label: string, sources: readonly SourceFixture[]) {
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: sourceReader(sources),
        executeForTest: async () => `initial:${label}`,
    });
    const input = discoveryInput(label, sources);
    const request = admissionRequest(label, sources, input);
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome", `${label} must admit a durable scheduler ledger`);
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const status = await runtime.waitForTerminal(admitted.taskId, 15);
    const background = backgroundTasks.getBackgroundTask(admitted.taskId);
    assert.ok(
        status && ["Succeeded", "Deferred"].includes(status.state),
        `${label} must produce sealed frozen source material; scheduler=${status?.state || "missing"}; background=${background?.status || "missing"}:${background?.error || "none"}`,
    );
    assert.equal(currentLedger(admitted.taskId).sourceMaterialization?.phase, "sealed");
    return { taskId: admitted.taskId, request };
}

async function recoverAsNewOwner(
    taskId: string,
    runtime: ReturnType<typeof restartedRuntime>["runtime"],
) {
    const previousOwner = currentLedger(taskId).schedulerOwner;
    assert.ok(previousOwner);
    const recovered = await runtime.control.recoverOwner({
        taskId,
        ownerId: runtime.ownerId,
        nowMs: Date.parse(previousOwner.expiresAt) + 5_000,
    });
    assert.equal(recovered.kind, "recovered");
    if (recovered.kind !== "recovered") throw new Error(recovered.reason);
    return { previousOwner, recoveredOwner: recovered.ownerLease };
}

async function runOwnerTakeoverScenario(label: string, oldOutcome: "return" | "throw"): Promise<void> {
    const source = createSource(label);
    let signalOldStarted!: () => void;
    const oldStarted = new Promise<void>(resolve => {
        signalOldStarted = resolve;
    });
    let releaseOld!: () => void;
    const oldGate = new Promise<void>(resolve => {
        releaseOld = resolve;
    });
    const oldRuntime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-old-${label}`,
        ownerLeaseMs: 1_000,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: sourceReader([source]),
        executeForTest: async () => {
            signalOldStarted();
            await oldGate;
            if (oldOutcome === "throw") throw new Error(`old callback ${label} failed after takeover`);
            return `old callback ${label} returned after takeover`;
        },
    });
    const request = admissionRequest(label, [source], discoveryInput(label, [source]));
    const admitted = await oldRuntime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await oldStarted;
    const oldLease = currentLedger(admitted.taskId).schedulerOwner;
    assert.ok(oldLease);
    assert.equal(oldLease.ownerId, oldRuntime.ownerId);

    const successor = restartedRuntime(`successor-${label}`);
    let blockedCallbackCalls = 0;
    const blocked = await successor.runtime.resumeExecution(admitted.taskId, resumeContext(admitted.taskId), async () => {
        blockedCallbackCalls += 1;
        return "must-not-run-under-foreign-owner";
    }, recoveryDescriptor(request));
    assert.equal(blocked?.kind, "blocked");
    assert.equal(blockedCallbackCalls, 0);

    const takeover = await recoverAsNewOwner(admitted.taskId, successor.runtime);
    assert.notEqual(takeover.recoveredOwner.leaseId, takeover.previousOwner.leaseId);
    let signalSuccessorStarted!: () => void;
    const successorStarted = new Promise<void>(resolve => {
        signalSuccessorStarted = resolve;
    });
    let releaseSuccessor!: () => void;
    const successorGate = new Promise<void>(resolve => {
        releaseSuccessor = resolve;
    });
    const successorExecution = successor.runtime.resumeExecution(
        admitted.taskId,
        resumeContext(admitted.taskId),
        async () => {
            signalSuccessorStarted();
            await successorGate;
            return `successor ${label} completed`;
        },
        recoveryDescriptor(request),
    );
    await successorStarted;
    assert.equal(currentLedger(admitted.taskId).schedulerOwner?.leaseId, takeover.recoveredOwner.leaseId);
    await delay(700);
    assert.equal(currentLedger(admitted.taskId).schedulerOwner?.leaseId, takeover.recoveredOwner.leaseId);

    releaseOld();
    await waitUntil(
        () => backgroundTasks.getBackgroundTask(admitted.taskId)?.status === "error",
        `${label} old background task did not observe owner fencing`,
    );
    const oldBackground = backgroundTasks.getBackgroundTask(admitted.taskId);
    assert.equal(oldBackground?.status, "error");
    assert.match(oldBackground?.error || "", /fenc|owner/iu);
    const fencedLedger = currentLedger(admitted.taskId);
    assert.equal(fencedLedger.task.state, "Running");
    assert.equal(fencedLedger.schedulerOwner?.leaseId, takeover.recoveredOwner.leaseId);

    releaseSuccessor();
    const successorResult = await successorExecution;
    assert.equal(successorResult?.kind, "resumed");
    assert.equal(successorResult?.status.state, "Succeeded");
    assert.equal(successor.liveCalls(), 0);
}

async function testInitialExecutionAcquiresOwnerAndSucceeds(): Promise<void> {
    const label = "initial-owner-success";
    const sealed = await sealedTask(label, [createSource(label)]);
    const ledger = currentLedger(sealed.taskId);
    assert.equal(ledger.task.state, "Succeeded");
    assert.equal(ledger.schedulerOwner?.ownerId, `record-scheduler-runtime-resume-${label}`);
    assert.equal(ledger.schedulerOwnerRecovery, undefined);
}

async function testSlowExecutionHeartbeatsOwnerLeaseAndStopsAfterSettlement(): Promise<void> {
    const label = "slow-owner-heartbeat";
    const source = createSource(label);
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-${label}`,
        ownerLeaseMs: 1_000,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: sourceReader([source]),
        executeForTest: async executionRequest => {
            const startedOwner = currentLedger(executionRequest.taskId).schedulerOwner;
            assert.ok(startedOwner);
            await delay(1_700);
            const maintainedOwner = currentLedger(executionRequest.taskId).schedulerOwner;
            assert.ok(maintainedOwner);
            assert.equal(maintainedOwner.ownerId, startedOwner.ownerId);
            assert.equal(maintainedOwner.leaseId, startedOwner.leaseId);
            assert.equal(maintainedOwner.schedulerEpoch, startedOwner.schedulerEpoch);
            assert.equal(maintainedOwner.fencingToken, startedOwner.fencingToken);
            assert.ok(Date.parse(maintainedOwner.heartbeatAt) > Date.parse(startedOwner.heartbeatAt));
            assert.ok(Date.parse(maintainedOwner.expiresAt) > Date.now());
            return "slow callback completed under maintained owner authority";
        },
    });
    const request = admissionRequest(label, [source], discoveryInput(label, [source]));
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const status = await runtime.waitForTerminal(admitted.taskId, 15);
    assert.equal(status?.state, "Succeeded");
    const settledLedger = currentLedger(admitted.taskId);
    const settledRevision = settledLedger.revision;
    const settledHeartbeatAt = settledLedger.schedulerOwner?.heartbeatAt;
    await delay(500);
    const afterTimerWindow = currentLedger(admitted.taskId);
    assert.equal(afterTimerWindow.revision, settledRevision);
    assert.equal(afterTimerWindow.schedulerOwner?.heartbeatAt, settledHeartbeatAt);
}

async function testOldReturningCallbackIsFencedAfterTakeover(): Promise<void> {
    await runOwnerTakeoverScenario("owner-takeover-return", "return");
}

async function testOldThrowingCallbackIsFencedAfterTakeover(): Promise<void> {
    await runOwnerTakeoverScenario("owner-takeover-throw", "throw");
}

async function testOwnerUnavailableLeavesLedgerRecoverable(): Promise<void> {
    const label = "owner-unavailable";
    const source = createSource(label);
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-old-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: sourceReader([source]),
        executeForTest: async () => {
            const error = new Error("pump owner unavailable") as Error & { code: string };
            error.code = "OWNER_UNAVAILABLE";
            throw error;
        },
    });
    const request = admissionRequest(label, [source], discoveryInput(label, [source]));
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await waitUntil(
        () => backgroundTasks.getBackgroundTask(admitted.taskId)?.status === "error",
        `${label} background task did not surface OWNER_UNAVAILABLE`,
    );
    assert.equal(currentLedger(admitted.taskId).task.state, "Running");

    const successor = restartedRuntime(`successor-${label}`);
    await recoverAsNewOwner(admitted.taskId, successor.runtime);
    const resumed = await successor.runtime.resumeExecution(
        admitted.taskId,
        resumeContext(admitted.taskId),
        async () => "owner-unavailable-recovered",
        recoveryDescriptor(request),
    );
    assert.equal(resumed?.kind, "resumed");
    assert.equal(resumed?.status.state, "Succeeded");
}

async function testForeignOwnerBlocksBeforeRecoveryPreparation(): Promise<void> {
    const label = "foreign-owner-prepare-isolation";
    const source = createSource(label);
    const pending = await pendingDiscoveryTask(label, source);
    try {
    const beforeClaim = currentLedger(pending.taskId);
    const claimed = await schedulerStore.claimSchedulerOwnerLease(
        pending.taskId,
        beforeClaim.revision,
        `record-scheduler-runtime-foreign-${label}`,
        { leaseMs: 30_000 },
    );
    await schedulerStore.completeSchedulerOwnerRecovery(
        pending.taskId,
        claimed.revision,
        claimed.ownerLease,
        { recoveredRecordWorkKeys: [] },
    );

    let discoveryCalls = 0;
    let sourceReadCalls = 0;
    let executionCalls = 0;
    let descriptorReads = 0;
    let factoryCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            discoveryCalls += 1;
            return discovery.discoverRecordCandidates(discoveryInput(label, [source]));
        },
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
    });
    const ledgerBeforeResume = structuredClone(currentLedger(pending.taskId));
    const evidenceBeforeResume = snapshotFileEvidence(dataRoot);
    const result = await runtime.resumeExecution(
        pending.taskId,
        resumeContext(pending.taskId),
        async () => {
            executionCalls += 1;
            return "must-not-run-under-foreign-owner";
        },
        async () => {
            factoryCalls += 1;
            return new Proxy(recoveryDescriptor(pending.request), {
                get(target, property, receiver) {
                    descriptorReads += 1;
                    return Reflect.get(target, property, receiver);
                },
            });
        },
    );
    assert.equal(result?.kind, "blocked");
    assert.equal(factoryCalls, 0, "foreign owner must block before invoking the recovery descriptor factory");
    assert.equal(descriptorReads, 0, "foreign owner must block before recovery descriptor preparation");
    assert.equal(discoveryCalls, 0);
    assert.equal(sourceReadCalls, 0);
    assert.equal(executionCalls, 0);
    assert.deepEqual(currentLedger(pending.taskId), ledgerBeforeResume);
    assert.deepEqual(snapshotFileEvidence(dataRoot), evidenceBeforeResume);
    } finally {
        pending.releaseDiscovery();
        await waitForBackgroundTaskSettlement(pending.taskId);
    }
}

async function testLazyDescriptorFactoryFailuresFailClosed(): Promise<void> {
    for (const failureKind of ["throws", "invalid"] as const) {
        const label = `lazy-descriptor-${failureKind}`;
        const source = createSource(label);
        const pending = await pendingDiscoveryTask(label, source);
        try {
            let factoryCalls = 0;
            let executionCalls = 0;
            const runtime = runtimeModule.createRecordSchedulerRuntime({
                mode: "test",
                ownerId: `record-scheduler-runtime-resume-${label}`,
                now: testNow,
                control: controlModule.createRecordSchedulerControl({ dataRoot }),
                productionSourceReader: sourceReader([source]),
            });
            await assert.rejects(
                runtime.resumeExecution(
                    pending.taskId,
                    resumeContext(pending.taskId),
                    async () => {
                        executionCalls += 1;
                        return "must-not-run-after-lazy-descriptor-failure";
                    },
                    async () => {
                        factoryCalls += 1;
                        if (failureKind === "throws") throw new Error(`descriptor factory ${failureKind}`);
                        return undefined as never;
                    },
                ),
                failureKind === "throws" ? /descriptor factory throws/u : /无效 descriptor/u,
            );
            assert.equal(factoryCalls, 1);
            assert.equal(executionCalls, 0);
            await waitUntil(
                () => currentLedger(pending.taskId).task.state === "RepairRequired",
                `${label} did not settle to RepairRequired after descriptor factory failure`,
            );
            const settled = currentLedger(pending.taskId);
            assert.equal(settled.task.terminalState, "RepairRequired");
        } finally {
            pending.releaseDiscovery();
        }
    }
}

async function testLazyDescriptorFactoryHeartbeatsAndFencesAfterTakeover(): Promise<void> {
    const label = "lazy-descriptor-takeover";
    const source = createSource(label);
    const pending = await pendingDiscoveryTask(label, source);
    try {
        let factoryCalls = 0;
        let executionCalls = 0;
        let signalFactoryStarted!: () => void;
        const factoryStarted = new Promise<void>(resolve => {
            signalFactoryStarted = resolve;
        });
        let releaseFactory!: () => void;
        const factoryGate = new Promise<void>(resolve => {
            releaseFactory = resolve;
        });
        const runtime = runtimeModule.createRecordSchedulerRuntime({
            mode: "test",
            ownerId: `record-scheduler-runtime-resume-${label}`,
            ownerLeaseMs: 1_000,
            now: testNow,
            control: controlModule.createRecordSchedulerControl({ dataRoot }),
            productionSourceReader: sourceReader([source]),
        });
        const resume = runtime.resumeExecution(
            pending.taskId,
            resumeContext(pending.taskId),
            async () => {
                executionCalls += 1;
                return "must-not-run-after-lazy-factory-takeover";
            },
            async () => {
                factoryCalls += 1;
                signalFactoryStarted();
                await factoryGate;
                return recoveryDescriptor(pending.request);
            },
        );
        await factoryStarted;
        const startedOwner = currentLedger(pending.taskId).schedulerOwner;
        assert.ok(startedOwner);
        assert.equal(startedOwner.ownerId, runtime.ownerId);
        await delay(700);
        const maintainedOwner = currentLedger(pending.taskId).schedulerOwner;
        assert.ok(maintainedOwner);
        assert.equal(maintainedOwner.leaseId, startedOwner.leaseId);
        assert.ok(Date.parse(maintainedOwner.heartbeatAt) > Date.parse(startedOwner.heartbeatAt));

        const oldOwner = structuredClone(maintainedOwner);
        const takeoverNowMs = Date.parse(oldOwner.expiresAt) + 5_000;
        const readExpiredOldOwnerLedger = () => {
            const ledger = currentLedger(pending.taskId);
            const owner = ledger.schedulerOwner;
            assert.ok(owner);
            assert.equal(owner.ownerId, oldOwner.ownerId);
            assert.equal(owner.leaseId, oldOwner.leaseId);
            assert.equal(owner.schedulerEpoch, oldOwner.schedulerEpoch);
            assert.equal(owner.fencingToken, oldOwner.fencingToken);
            assert.ok(Date.parse(owner.expiresAt) <= takeoverNowMs);
            return ledger;
        };
        let takeover: Awaited<ReturnType<typeof schedulerStore.claimSchedulerOwnerLease>> | undefined;
        for (let attempt = 1; attempt <= 5; attempt += 1) {
            const ledgerBeforeTakeover = readExpiredOldOwnerLedger();
            try {
                takeover = await schedulerStore.claimSchedulerOwnerLease(
                    pending.taskId,
                    ledgerBeforeTakeover.revision,
                    `record-scheduler-runtime-successor-${label}`,
                    { leaseMs: 1_000, nowMs: takeoverNowMs },
                );
                break;
            } catch (error) {
                if (!(error instanceof schedulerStore.SchedulerLedgerConflictError) || error.code !== "REVISION_CONFLICT") throw error;
                if (attempt === 5) throw error;
                readExpiredOldOwnerLedger();
            }
        }
        assert.ok(takeover);
        await schedulerStore.completeSchedulerOwnerRecovery(
            pending.taskId,
            takeover.revision,
            takeover.ownerLease,
            { recoveredRecordWorkKeys: [], nowMs: takeoverNowMs },
        );
        const ledgerAfterTakeover = structuredClone(currentLedger(pending.taskId));
        releaseFactory();
        await assert.rejects(resume, /fenc|owner|authority/iu);
        assert.equal(factoryCalls, 1);
        assert.equal(executionCalls, 0);
        const fenced = currentLedger(pending.taskId);
        assert.equal(fenced.schedulerOwner?.leaseId, takeover.ownerLease.leaseId);
        assert.equal(fenced.task.state, ledgerAfterTakeover.task.state);
        assert.equal(fenced.task.terminalState, ledgerAfterTakeover.task.terminalState);
    } finally {
        pending.releaseDiscovery();
    }
}

async function testFallbackAdapterUsesFreshScanIdsForLostRechecks(): Promise<void> {
    const label = "fallback-scan-correlation";
    const source = createSource(label);
    const request = {
        kind: "stale_check" as const,
        selector: "stale_only" as const,
        requestKey: `fallback-scan-request-${label}`,
        workspaceHash: source.workspaceHash,
        workspacePath: source.workspacePath,
        hosts: ["codex" as const],
        targets: [{
            host: "codex" as const,
            conversationId: source.conversationId,
            workspaceHash: source.workspaceHash,
            workspacePath: source.workspacePath,
        }],
        limit: 1,
    };
    let currentTimeMs = baseTimeMs;
    let scanNumber = 0;
    const enumerationScanIds: string[] = [];
    const exactFetchScanIds: string[] = [];
    const adapter = runtimeModule.createProductionRecordSchedulerSourceEvidenceAdapter({
        listCodexThreads: () => [] as never,
        enumerateCodex: async (options: { scanId: string }) => {
            enumerationScanIds.push(options.scanId);
            return {
                evidence: absentFallbackEnumeration(source, options.scanId, new Date(currentTimeMs).toISOString()),
                threads: [],
            } as never;
        },
        fetchCodex: async (options: { scanId: string }) => {
            exactFetchScanIds.push(options.scanId);
            const enumeration = absentFallbackEnumeration(source, options.scanId, new Date(currentTimeMs).toISOString());
            return { evidence: absentFallbackExactFetch(enumeration) } as never;
        },
    } as never, undefined, {
        now: () => new Date(currentTimeMs),
        scanIdFactory: () => `fallback-scan-${++scanNumber}`,
    });
    const buildInput = async () => {
        const result = await adapter.buildDiscoveryInput(request);
        if (!("input" in result)) throw new Error("fallback adapter must return a scheduler discovery build result");
        return result.input;
    };
    const first = await buildInput();
    assert.equal(first.sourceEnumerations[0]?.exactFetch?.kind, "exact_fetch");
    assert.equal(first.sourceEnumerations[0]?.exactFetch?.observedAt.scanId, "fallback-scan-1");
    assert.equal(first.sourceEnumerations[0]?.exactFetch?.exactFetchResult, "not_found");
    currentTimeMs += discovery.LOST_RECHECK_INTERVAL_MS - 1;
    const justShort = await buildInput();
    assert.equal(justShort.sourceEnumerations[0]?.exactFetch?.observedAt.scanId, "fallback-scan-2");
    currentTimeMs += 1;
    const atWindow = await buildInput();
    assert.equal(atWindow.sourceEnumerations[0]?.exactFetch?.observedAt.scanId, "fallback-scan-3");

    assert.deepEqual(enumerationScanIds, ["fallback-scan-1", "fallback-scan-2", "fallback-scan-3"]);
    assert.deepEqual(exactFetchScanIds, enumerationScanIds, "exact fetch must share its enumeration scan correlation id");
    const base = discoveryInput(label, [source]);
    const justShortSnapshot = discovery.discoverRecordCandidates({
        ...base,
        request: { ...base.request, snapshotId: `${label}-just-short` },
        sourceEnumerations: [...first.sourceEnumerations, ...justShort.sourceEnumerations],
        absenceObservations: [...first.absenceObservations, ...justShort.absenceObservations],
    });
    assert.equal(justShortSnapshot.candidates[0]?.classification, "Unresolved");
    const atWindowSnapshot = discovery.discoverRecordCandidates({
        ...base,
        request: { ...base.request, snapshotId: `${label}-at-window` },
        sourceEnumerations: [...first.sourceEnumerations, ...atWindow.sourceEnumerations],
        absenceObservations: [...first.absenceObservations, ...atWindow.absenceObservations],
    });
    assert.equal(atWindowSnapshot.candidates[0]?.classification, "Lost");
}

async function pendingDiscoveryTask(label: string, source: SourceFixture) {
    let signalDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>(resolve => {
        signalDiscoveryStarted = resolve;
    });
    let resolveDiscovery!: (snapshot: ReturnType<typeof discovery.discoverRecordCandidates>) => void;
    const discoveryGate = new Promise<ReturnType<typeof discovery.discoverRecordCandidates>>(resolve => {
        resolveDiscovery = resolve;
    });
    const releasedSnapshot = discovery.discoverRecordCandidates(discoveryInput(label, [source]));
    let discoveryReleased = false;
    const releaseDiscovery = () => {
        if (discoveryReleased) return;
        discoveryReleased = true;
        resolveDiscovery(releasedSnapshot);
    };
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-pending-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            signalDiscoveryStarted();
            return discoveryGate;
        },
        productionSourceReader: sourceReader([source]),
        executeForTest: async () => `initial:${label}`,
    });
    const request = admissionRequest(label, [source]);
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await discoveryStarted;
    await waitUntil(
        () => currentLedger(admitted.taskId).task.state === "Preparing",
        `${label} did not stop in Preparing with a pending CandidateSnapshot`,
    );
    assert.match(currentLedger(admitted.taskId).candidateSnapshot.snapshotId, /:pending$/u);
    return { taskId: admitted.taskId, request, releaseDiscovery };
}

async function sourceIntentTask(label: string, source: SourceFixture) {
    let signalSourceReadStarted!: () => void;
    const sourceReadStarted = new Promise<void>(resolve => {
        signalSourceReadStarted = resolve;
    });
    let resolveSourceRead!: (scan: ReturnType<typeof completeScan>) => void;
    const sourceReadGate = new Promise<ReturnType<typeof completeScan>>(resolve => {
        resolveSourceRead = resolve;
    });
    let sourceReadReleased = false;
    const releaseSourceRead = () => {
        if (sourceReadReleased) return;
        sourceReadReleased = true;
        resolveSourceRead(completeScan(source));
    };
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-intent-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: {
            scan: async () => {
                signalSourceReadStarted();
                return sourceReadGate;
            },
        } as never,
        executeForTest: async () => `initial:${label}`,
    });
    const request = admissionRequest(label, [source], discoveryInput(label, [source]));
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await sourceReadStarted;
    await waitUntil(
        () => currentLedger(admitted.taskId).sourceMaterialization?.phase === "intent",
        `${label} did not persist source materialization intent`,
    );
    assert.doesNotMatch(currentLedger(admitted.taskId).candidateSnapshot.snapshotId, /:pending$/u);
    return { taskId: admitted.taskId, request, releaseSourceRead };
}

async function testPendingDiscoveryResumeUsesDescriptorAndSeals(): Promise<void> {
    const label = "pending-window";
    const source = createSource(label);
    const input = discoveryInput(label, [source]);
    const pending = await pendingDiscoveryTask(label, source);
    try {
    let discoveryCalls = 0;
    let sourceReadCalls = 0;
    let legacyValidationCalls = 0;
    let executionCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            discoveryCalls += 1;
            return discovery.discoverRecordCandidates(input);
        },
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
    });
    const descriptor = {
        ...recoveryDescriptor(pending.request),
        validateLegacyState: async (snapshot?: Awaited<ReturnType<typeof discovery.discoverRecordCandidates>>) => {
            legacyValidationCalls += 1;
            assert.equal(snapshot?.snapshotId, `snapshot-${label}`);
        },
    };
    const result = await runtime.resumeExecution(pending.taskId, resumeContext(pending.taskId), async (_context, snapshot, frozenSources) => {
        executionCalls += 1;
        assert.equal(snapshot?.snapshotId, `snapshot-${label}`);
        assert.equal(frozenSources?.sources[0]?.document.messages[1]?.content, source.body);
        return "pending-window-resumed";
    }, descriptor);
    assert.equal(result?.kind, "resumed");
    assert.equal(result?.status.state, "Succeeded");
    assert.equal(discoveryCalls, 1);
    assert.equal(sourceReadCalls, 1);
    assert.equal(legacyValidationCalls, 1);
    assert.equal(executionCalls, 1);
    assert.equal(currentLedger(pending.taskId).sourceMaterialization?.phase, "sealed");
    } finally {
        pending.releaseDiscovery();
        await waitForBackgroundTaskSettlement(pending.taskId);
    }
}

async function testPendingDiscoverySurvivesSuccessiveOwnerRestartsWithoutSpool(): Promise<void> {
    const label = "pending-successive-owner-restarts";
    const source = createSource(label);
    const input = discoveryInput(label, [source]);
    const pending = await pendingDiscoveryTask(label, source);
    try {
        const beforeClaim = currentLedger(pending.taskId);
        const expiredOwnerNowMs = testNow().getTime() - 10_000;
        const claimed = await schedulerStore.claimSchedulerOwnerLease(
            pending.taskId,
            beforeClaim.revision,
            `record-scheduler-runtime-dead-${label}`,
            { nowMs: expiredOwnerNowMs, leaseMs: 1 },
        );
        await schedulerStore.completeSchedulerOwnerRecovery(
            pending.taskId,
            claimed.revision,
            claimed.ownerLease,
            { recoveredRecordWorkKeys: [], nowMs: expiredOwnerNowMs },
        );
        const spoolManifest = path.join(dataRoot, ".record-scheduler-spool-v2", `m.${sha256(pending.taskId)}.json`);
        assert.equal(fs.existsSync(spoolManifest), false, "pending discovery must not require a spool manifest before evidence freeze");

        let discoveryCalls = 0;
        let sourceReadCalls = 0;
        let executionCalls = 0;
        const successor = runtimeModule.createRecordSchedulerRuntime({
            mode: "test",
            ownerId: `record-scheduler-runtime-successor-${label}`,
            now: testNow,
            control: controlModule.createRecordSchedulerControl({ dataRoot }),
            discover: async () => {
                discoveryCalls += 1;
                return discovery.discoverRecordCandidates(input);
            },
            productionSourceReader: {
                scan: async () => {
                    sourceReadCalls += 1;
                    return completeScan(source);
                },
            } as never,
        });
        const result = await successor.resumeExecution(
            pending.taskId,
            resumeContext(pending.taskId),
            async (_context, snapshot, frozenSources) => {
                executionCalls += 1;
                assert.equal(snapshot?.snapshotId, `snapshot-${label}`);
                assert.equal(frozenSources?.sources[0]?.document.messages[1]?.content, source.body);
                return "pending-successive-owner-restarts-resumed";
            },
            recoveryDescriptor(pending.request),
        );
        assert.equal(result?.kind, "resumed", result?.reason || result?.result);
        assert.equal(result?.status.state, "Succeeded");
        assert.equal(discoveryCalls, 1);
        assert.equal(sourceReadCalls, 1);
        assert.equal(executionCalls, 1);
        assert.equal(currentLedger(pending.taskId).sourceMaterialization?.phase, "sealed");
    } finally {
        pending.releaseDiscovery();
        await waitForBackgroundTaskSettlement(pending.taskId);
    }
}

async function testPendingDiscoveryCancellationDoesNotPublishSpool(): Promise<void> {
    const label = "pending-discovery-cancel";
    const source = createSource(label);
    const pending = await pendingDiscoveryTask(label, source);
    const manifestPath = path.join(dataRoot, ".record-scheduler-spool-v2", `m.${sha256(pending.taskId)}.json`);
    try {
        assert.equal(fs.existsSync(manifestPath), false);
        const control = controlModule.createRecordSchedulerControl({ dataRoot });
        const cancelled = await control.cancel(pending.taskId);
        assert.equal(cancelled.disposition, "cancelled", cancelled.reason);
        assert.equal(cancelled.status.taskState, "Cancelled");
        assert.equal(fs.existsSync(manifestPath), false, "pending cancellation must not invent an empty spool task");
    } finally {
        pending.releaseDiscovery();
        await waitForBackgroundTaskSettlement(pending.taskId);
    }
    assert.equal(currentLedger(pending.taskId).task.state, "Cancelled");
    assert.equal(fs.existsSync(manifestPath), false, "late discovery completion must not publish evidence after cancellation");
}

async function testFrozenCandidateIntentSettlesDeferredWithoutLiveSourceRead(): Promise<void> {
    const label = "intent-window";
    const source = createSource(label);
    const intent = await sourceIntentTask(label, source);
    try {
    const frozenSnapshotId = currentLedger(intent.taskId).candidateSnapshot.snapshotId;
    let discoveryCalls = 0;
    let sourceReadCalls = 0;
    let executionCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            discoveryCalls += 1;
            throw new Error("frozen CandidateSnapshot recovery must not enumerate again");
        },
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
    });
    const result = await runtime.resumeExecution(intent.taskId, resumeContext(intent.taskId), async () => {
        executionCalls += 1;
        return "must-not-run-after-frozen-source-intent-recovery";
    }, recoveryDescriptor(intent.request));
    assert.equal(result?.kind, "settled");
    assert.equal(result?.status.state, "Deferred");
    assert.equal(discoveryCalls, 0);
    assert.equal(sourceReadCalls, 0);
    assert.equal(executionCalls, 0);
    assert.equal(currentLedger(intent.taskId).candidateSnapshot.snapshotId, frozenSnapshotId);
    assert.equal(currentLedger(intent.taskId).sourceMaterialization?.phase, "sealed");
    assert.equal(
        currentLedger(intent.taskId).sourceMaterialization?.outcomes[0]?.reason,
        "source materialization recovery refused live reread without a durable outcome",
    );
    } finally {
        intent.releaseSourceRead();
        await waitForBackgroundTaskSettlement(intent.taskId);
    }
}

async function testMismatchedRecoveryDescriptorFailsClosed(): Promise<void> {
    const label = "descriptor-mismatch";
    const source = createSource(label);
    const pending = await pendingDiscoveryTask(label, source);
    try {
    let discoveryCalls = 0;
    let sourceReadCalls = 0;
    let executionCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            discoveryCalls += 1;
            return discovery.discoverRecordCandidates(discoveryInput(label, [source]));
        },
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
    });
    const descriptor = recoveryDescriptor(pending.request);
    await assert.rejects(
        () => runtime.resumeExecution(pending.taskId, resumeContext(pending.taskId), async () => {
            executionCalls += 1;
            return "must-not-run";
        }, {
            ...descriptor,
            requestSummary: { ...descriptor.requestSummary, label: `${label}-wrong-request` },
        }),
        error => error instanceof runtimeModule.RecordSchedulerRepairRequiredError
            && error.code === "SCHEDULER_REPAIR_REQUIRED",
    );
    assert.equal(runtime.status(pending.taskId)?.state, "RepairRequired");
    assert.equal(discoveryCalls, 0);
    assert.equal(sourceReadCalls, 0);
    assert.equal(executionCalls, 0);
    } finally {
        pending.releaseDiscovery();
        await waitForBackgroundTaskSettlement(pending.taskId);
    }
}

async function testActiveRecoveryWithoutDescriptorFailsBeforeEvidenceOrCallback(): Promise<void> {
    const label = "missing-descriptor";
    const sealed = await sealedTask(label, [createSource(label)]);
    await setRecoverableState(sealed.taskId, "Queued");
    const markerRef = currentLedger(sealed.taskId).sourceMaterialization?.markerRef;
    assert.ok(markerRef);
    fs.writeFileSync(path.resolve(dataRoot, markerRef.path), "tampered active marker", "utf8");
    const restarted = restartedRuntime(label);
    let executionCalls = 0;
    await assert.rejects(
        () => restarted.runtime.resumeExecution(sealed.taskId, resumeContext(sealed.taskId), async () => {
            executionCalls += 1;
            return "must-not-run";
        }),
        error => error instanceof runtimeModule.RecordSchedulerRepairRequiredError
            && error.code === "SCHEDULER_REPAIR_REQUIRED"
            && /matching admission descriptor/u.test(error.message),
    );
    assert.equal(restarted.runtime.status(sealed.taskId)?.state, "RepairRequired");
    assert.equal(restarted.liveCalls(), 0);
    assert.equal(executionCalls, 0);
}

async function testResumeUsesSealedFrozenSourceAndRunsCallback(): Promise<void> {
    const source = createSource("sealed-source");
    const sealed = await sealedTask("sealed-source", [source]);
    const taskId = sealed.taskId;
    await setRecoverableState(taskId, "Queued");
    const restarted = restartedRuntime("sealed-source");
    let executions = 0;
    const result = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async (_context, snapshot, frozenSources) => {
        executions += 1;
        assert.equal(snapshot?.snapshotId, "snapshot-sealed-source");
        assert.equal(frozenSources?.sources.length, 1);
        assert.equal(frozenSources?.sources[0]?.document.messages[1]?.content, source.body);
        return "resumed-from-frozen-source";
    }, recoveryDescriptor(sealed.request));
    assert.ok(result && result.kind === "resumed", "owner recovery alone must not be reported as a successful resume");
    assert.equal(result?.result, "resumed-from-frozen-source");
    assert.equal(result?.status.state, "Succeeded");
    assert.equal(executions, 1, "resume must invoke the supplied execution callback");
    assert.equal(restarted.liveCalls(), 0, "sealed resume must not call live discovery or source reader");
}

async function testAuthoritativeLedgerNonterminalResumeMatrix(): Promise<void> {
    for (const state of ["Queued", "Running", "Committing"] as const) {
        const label = `authoritative-ledger-${state.toLowerCase()}`;
        const sealed = await sealedTask(label, [createSource(label)]);
        const taskId = sealed.taskId;
        await setRecoverableState(taskId, state);
        assert.equal(currentLedger(taskId).task.state, state);

        const restarted = restartedRuntime(label);
        const commitContinuationPath = path.join(dataRoot, `commit-continuation-${label}.json`);
        let callbackCalls = 0;
        const resumed = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
            callbackCalls += 1;
            assert.equal(callbackCalls, 1, `${state} recovery must not duplicate the execution callback`);
            if (state === "Committing") {
                assert.equal(fs.existsSync(commitContinuationPath), false, "Committing continuation must start exactly once");
                fs.writeFileSync(commitContinuationPath, JSON.stringify({ taskId, continuationCalls: callbackCalls }), "utf8");
            }
            return `${state}-authoritative-ledger-resumed`;
        }, recoveryDescriptor(sealed.request));

        assert.ok(resumed && resumed.kind === "resumed", `${state} must resume from the authoritative ledger`);
        assert.equal(resumed?.status.taskId, taskId);
        assert.equal(resumed?.status.state, "Succeeded");
        assert.equal(currentLedger(taskId).task.state, "Succeeded");
        assert.equal(callbackCalls, 1);
        assert.equal(restarted.liveCalls(), 0);
        if (state === "Committing") {
            assert.equal(fs.readFileSync(commitContinuationPath, "utf8"), JSON.stringify({ taskId, continuationCalls: 1 }));
        }

        const settledLedger = structuredClone(currentLedger(taskId));
        const replay = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
            callbackCalls += 1;
            return "must-not-run-after-terminal-ledger-replay";
        });
        assert.equal(replay?.kind, "terminal");
        assert.equal(replay?.status.taskId, taskId);
        assert.equal(replay?.status.state, "Succeeded");
        assert.equal(callbackCalls, 1, `${state} terminal replay must not invoke the execution callback`);
        assert.deepEqual(currentLedger(taskId), settledLedger, `${state} terminal replay must be ledger read-only`);
        if (state === "Committing") {
            assert.equal(fs.readFileSync(commitContinuationPath, "utf8"), JSON.stringify({ taskId, continuationCalls: 1 }));
        }
    }
}

async function testKnownTerminalDoesNotExecute(): Promise<void> {
    const taskId = (await sealedTask("known-terminal", [createSource("known-terminal")])).taskId;
    const markerRef = currentLedger(taskId).sourceMaterialization?.markerRef;
    assert.ok(markerRef);
    fs.writeFileSync(path.resolve(dataRoot, markerRef.path), "tampered terminal marker", "utf8");
    const restarted = restartedRuntime("known-terminal");
    let executions = 0;
    const result = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
        executions += 1;
        return "must-not-run";
    });
    assert.equal(result?.kind, "terminal");
    assert.equal(result?.status.state, "Succeeded");
    assert.equal(executions, 0);
    assert.equal(restarted.liveCalls(), 0);
}

async function testDeferredTerminalResumeRemainsReadOnly(): Promise<void> {
    const taskId = (await sealedTask("deferred-terminal", [createSource("deferred-terminal", "unresolved")])).taskId;
    const ledgerBeforeResume = structuredClone(currentLedger(taskId));
    const evidenceBeforeResume = snapshotFileEvidence(dataRoot);
    assert.equal(ledgerBeforeResume.task.state, "Deferred");

    const restarted = restartedRuntime("deferred-terminal");
    let callbackCalls = 0;
    const result = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
        callbackCalls += 1;
        return "must-not-run-for-terminal-deferred-ledger";
    });
    assert.equal(result?.kind, "terminal");
    assert.equal(result?.status.taskId, taskId);
    assert.equal(result?.status.state, "Deferred");
    assert.equal(callbackCalls, 0);
    assert.equal(restarted.liveCalls(), 0);
    assert.deepEqual(currentLedger(taskId), ledgerBeforeResume);
    assert.deepEqual(snapshotFileEvidence(dataRoot), evidenceBeforeResume);
}

async function testCancelRequestedDoesNotExecute(): Promise<void> {
    const taskId = (await sealedTask("cancel-requested", [createSource("cancel-requested")])).taskId;
    await setRecoverableState(taskId, "CancelRequested");
    const restarted = restartedRuntime("cancel-requested");
    let executions = 0;
    const result = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
        executions += 1;
        return "must-not-run";
    });
    assert.equal(result?.kind, "cancelled");
    assert.equal(result?.status.state, "Cancelled");
    assert.equal(executions, 0);
    assert.equal(restarted.liveCalls(), 0);
}

async function testUnresolvedFrozenSourcesSettleDeferred(): Promise<void> {
    const sealed = await sealedTask("unresolved", [createSource("unresolved", "unresolved")]);
    const taskId = sealed.taskId;
    await setRecoverableState(taskId, "Queued");
    const restarted = restartedRuntime("unresolved");
    let executions = 0;
    const result = await restarted.runtime.resumeExecution(taskId, resumeContext(taskId), async () => {
        executions += 1;
        return "must-not-run";
    }, recoveryDescriptor(sealed.request));
    assert.equal(result?.kind, "settled");
    assert.equal(result?.status.state, "Deferred");
    assert.equal(executions, 0);
    assert.equal(restarted.liveCalls(), 0);
}

async function testDiscoveryUnresolvedSettlesDeferredWithoutFalseNoop(): Promise<void> {
    const label = "discovery-unresolved";
    const source = createSource(label);
    let sourceReadCalls = 0;
    let executionCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-resume-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
        executeForTest: async () => {
            executionCalls += 1;
            return "must-not-run-for-discovery-unresolved";
        },
    });
    const request = admissionRequest(label, [source], discoveryInput(label, [source], false));
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const status = await runtime.waitForTerminal(admitted.taskId, 15);
    assert.equal(status?.state, "Deferred");
    assert.equal(sourceReadCalls, 0);
    assert.equal(executionCalls, 0);
    const ledger = currentLedger(admitted.taskId);
    assert.equal(ledger.task.recordItems.total, 1);
    assert.equal(ledger.task.recordItems.unresolved, 1);
    assert.equal(ledger.task.sourceResolution?.phase, "deferred");
    assert.equal(ledger.task.sourceResolution?.selectedCount, 1);
    assert.equal(ledger.task.sourceResolution?.deferredReason, "source_unresolved");
    const frozen = await runtime.readFrozenSources(admitted.taskId);
    assert.equal(frozen.sources.length, 0);
    assert.deepEqual(frozen.unresolved.map(issue => issue.reason), ["record-covered-revision-missing"]);
}

async function testAdmittedSuspensionWakeReusesFrozenEvidence(): Promise<void> {
    const label = "admitted-suspension-wake";
    const source = createSource(label);
    const input = discoveryInput(label, [source]);
    let discoveryCalls = 0;
    let sourceReadCalls = 0;
    let executionCalls = 0;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-runtime-${label}`,
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        discover: async () => {
            discoveryCalls += 1;
            return discovery.discoverRecordCandidates(input);
        },
        productionSourceReader: {
            scan: async () => {
                sourceReadCalls += 1;
                return completeScan(source);
            },
        } as never,
        executeForTest: async request => {
            executionCalls += 1;
            if (executionCalls === 1) {
                throw backgroundTaskSuspension.createBackgroundTaskSuspension({
                    taskId: request.taskId,
                    wakeAt: new Date(Date.now() + 60_000).toISOString(),
                    waitingReason: "等待 provider capacity 回归测试",
                    ledgerRevision: currentLedger(request.taskId).revision,
                });
            }
            return "resumed-from-frozen-evidence";
        },
    });
    const request = admissionRequest(label, [source]);
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await waitUntil(
        () => backgroundTasks.getBackgroundTask(admitted.taskId)?.status === "suspended",
        `${label} did not enter suspended background state`,
    );
    const suspended = backgroundTasks.getBackgroundTask(admitted.taskId);
    assert.ok(suspended);
    assert.equal(currentLedger(admitted.taskId).sourceMaterialization?.phase, "sealed");
    const frozenBefore = currentLedger(admitted.taskId);
    const candidateRefBefore = structuredClone(frozenBefore.candidateSnapshot.snapshotRef);
    const sourceRefsBefore = frozenBefore.sourceSnapshots.map(snapshot => ({
        sourceSnapshotId: snapshot.sourceSnapshotId,
        snapshotRef: structuredClone(snapshot.snapshotRef),
        contentRef: structuredClone(snapshot.contentRef),
    }));
    const wake = backgroundTasks.wakeBackgroundTask(admitted.taskId, {
        suspensionRevision: suspended!.suspensionRevision!,
        ledgerRevision: suspended!.suspensionLedgerRevision!,
    });
    assert.equal(wake.outcome, "woken");
    const settled = await waitForBackgroundTaskSettlement(admitted.taskId);
    assert.equal(settled.status, "done", settled.error || "suspension wake should settle successfully");
    assert.equal(settled.result, "resumed-from-frozen-evidence");
    assert.equal(runtime.status(admitted.taskId)?.state, "Succeeded");
    assert.equal(discoveryCalls, 1, "wake must not re-enumerate discovery after the snapshot is frozen");
    assert.equal(sourceReadCalls, 1, "wake must not re-read live source after materialization is sealed");
    assert.equal(executionCalls, 2, "wake must resume the same admitted callback exactly once");
    const frozenAfter = currentLedger(admitted.taskId);
    assert.deepEqual(frozenAfter.candidateSnapshot.snapshotRef, candidateRefBefore);
    assert.deepEqual(
        frozenAfter.sourceSnapshots.map(snapshot => ({
            sourceSnapshotId: snapshot.sourceSnapshotId,
            snapshotRef: snapshot.snapshotRef,
            contentRef: snapshot.contentRef,
        })),
        sourceRefsBefore,
    );
}

async function testCallbackErrorsSettleFailedFinalOrRepairRequired(): Promise<void> {
    const ordinaryTask = await sealedTask("ordinary-error", [createSource("ordinary-error")]);
    const ordinaryTaskId = ordinaryTask.taskId;
    await setRecoverableState(ordinaryTaskId, "Queued");
    const ordinary = restartedRuntime("ordinary-error");
    await assert.rejects(
        () => ordinary.runtime.resumeExecution(ordinaryTaskId, resumeContext(ordinaryTaskId), async () => {
            throw new Error("ordinary resume callback failure");
        }, recoveryDescriptor(ordinaryTask.request)),
        /ordinary resume callback failure/u,
    );
    assert.equal(ordinary.runtime.status(ordinaryTaskId)?.state, "FailedFinal");
    assert.equal(ordinary.liveCalls(), 0);

    const repairTask = await sealedTask("repair-error", [createSource("repair-error")]);
    const repairTaskId = repairTask.taskId;
    await setRecoverableState(repairTaskId, "Queued");
    const repair = restartedRuntime("repair-error");
    await assert.rejects(
        () => repair.runtime.resumeExecution(repairTaskId, resumeContext(repairTaskId), async () => {
            throw new runtimeModule.RecordSchedulerRepairRequiredError("repair resume callback failure");
        }, recoveryDescriptor(repairTask.request)),
        error => error instanceof runtimeModule.RecordSchedulerRepairRequiredError
            && error.code === "SCHEDULER_REPAIR_REQUIRED",
    );
    assert.equal(repair.runtime.status(repairTaskId)?.state, "RepairRequired");
    assert.equal(repair.liveCalls(), 0);

    const driverRepairTask = await sealedTask("driver-repair-error", [createSource("driver-repair-error")]);
    const driverRepairTaskId = driverRepairTask.taskId;
    await setRecoverableState(driverRepairTaskId, "Queued");
    const driverRepair = restartedRuntime("driver-repair-error");
    await assert.rejects(
        () => driverRepair.runtime.resumeExecution(driverRepairTaskId, resumeContext(driverRepairTaskId), async () => {
            throw Object.assign(new Error("execution driver repair-required failure"), { code: "REPAIR_REQUIRED" as const });
        }, recoveryDescriptor(driverRepairTask.request)),
        error => (error as { code?: unknown }).code === "REPAIR_REQUIRED",
    );
    assert.equal(driverRepair.runtime.status(driverRepairTaskId)?.state, "RepairRequired");
    assert.equal(driverRepair.liveCalls(), 0);
}

async function testCacheGenerationSurvivesFrozenResumeAndReleasesPin(): Promise<void> {
    sourceCache.resetConversationSourceCacheForTests();
    sourceCache.setConversationSourceCacheDataRootForTests(dataRoot);
    const source = createSource("cache-generation");
    const cacheKey = { source: "codex", conversationId: source.conversationId };
    const fingerprint = { revision: "cache-generation-v1" };
    const cached = await sourceCache.readOrBuildConversationSourceCache({
        key: cacheKey,
        fingerprint,
        build: () => ({
            snapshot: { conversationId: source.conversationId, revision: source.revision },
            rounds: [{ roundIndex: 1 }, { roundIndex: 2 }, { roundIndex: 3 }, { roundIndex: 4 }, { roundIndex: 5 }],
        }),
        getRoundNumber: round => round.roundIndex,
    });
    const cacheGeneration = { key: cacheKey, generation: cached.generation, fingerprint };
    const requests: Array<{ cacheReadStartRound?: number; cacheGeneration?: { generation: string }; sourceSnapshot?: Record<string, unknown> }> = [];
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: "record-scheduler-runtime-resume-cache-generation",
        now: testNow,
        control: controlModule.createRecordSchedulerControl({ dataRoot }),
        productionSourceReader: {
            scan: async request => {
                requests.push({
                    cacheReadStartRound: request.cacheReadStartRound,
                    ...(request.cacheGeneration ? { cacheGeneration: request.cacheGeneration } : {}),
                    ...(request.sourceSnapshot ? { sourceSnapshot: request.sourceSnapshot } : {}),
                });
                return {
                    ...completeScan(source),
                    cacheGeneration,
                    cacheSourceSnapshot: { conversationId: source.conversationId, generation: cached.generation },
                };
            },
        } as never,
        executeForTest: async () => "cache-generation-initial",
    });
    const input = discoveryInput("cache-generation", [source]);
    input.request.filters.extensions = {
        "record-source-cache-references": [{
            host: "codex",
            conversationId: source.conversationId,
            workspaceHash: source.workspaceHash,
            cacheGeneration,
            cacheReadStartRound: 2,
            sourceSnapshot: { conversationId: source.conversationId, generation: cached.generation },
        }],
    };
    input.recordIndex.entries[0] = discovery.buildRecordIndexEntry({
        recordId: "record-cache-generation",
        source: sourceIdentity(source),
        indexSnapshotId: input.recordIndex.scopes[0]!.snapshotId,
        indexRevision: input.recordIndex.scopes[0]!.indexRevision,
        coveredRevision: { revision: "covered-before-cache-generation", sequence: 0 },
        recordBodyHash: `sha256:${sha256("record-cache-generation")}`,
        extensions: { lastUpdatedRound: 3 },
    });
    const request = admissionRequest("cache-generation", [source], input);
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const terminal = await runtime.waitForTerminal(admitted.taskId, 15);
    assert.equal(terminal?.state, "Succeeded");
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.cacheReadStartRound, 2, "scheduler 必须保留上游按 Record 回滚边界计算的缓存起点，不能覆盖成 lastUpdatedRound + 1");
    assert.equal(requests[0]?.cacheGeneration?.generation, cached.generation);
    assert.deepEqual(requests[0]?.sourceSnapshot, { conversationId: source.conversationId, generation: cached.generation });
    const frozen = await runtime.readFrozenSources(admitted.taskId);
    assert.equal(frozen.sources[0]?.cacheGeneration?.generation, cached.generation);
    assert.deepEqual(frozen.sources[0]?.cacheSourceSnapshot, { conversationId: source.conversationId, generation: cached.generation });
    const diagnostics = sourceCache.getConversationSourceCacheDiagnostics();
    assert.equal(diagnostics.pinsCreated, 1);
    assert.equal(diagnostics.pinsReleased, 1, "terminal completion must release the task pin");

    await setRecoverableState(admitted.taskId, "Queued");
    const successor = restartedRuntime("cache-generation");
    const resumed = await successor.runtime.resumeExecution(
        admitted.taskId,
        resumeContext(admitted.taskId),
        async (_context, _snapshot, frozenSources) => {
            assert.equal(frozenSources?.sources[0]?.cacheGeneration?.generation, cached.generation);
            assert.deepEqual(frozenSources?.sources[0]?.cacheSourceSnapshot, { conversationId: source.conversationId, generation: cached.generation });
            return "cache-generation-resumed";
        },
        recoveryDescriptor(request),
    );
    assert.equal(resumed?.kind, "resumed");
    assert.equal(resumed?.status.taskId, admitted.taskId);
    assert.equal(successor.liveCalls(), 0, "sealed restart must not replace the frozen cache generation with a live reread");

    for (const state of ["CancelRequested", "Cancelling"] as const) {
        await sourceCache.pinConversationSourceCacheGeneration({ ...cacheGeneration, ownerId: admitted.taskId });
        await setRecoverableState(admitted.taskId, state);
        let callbackCalls = 0;
        const cancelled = await successor.runtime.resumeExecution(
            admitted.taskId,
            resumeContext(admitted.taskId),
            async () => {
                callbackCalls += 1;
                return "must-not-run-after-cancel";
            },
            recoveryDescriptor(request),
        );
        assert.equal(cancelled?.kind, "cancelled");
        assert.equal(cancelled?.status.state, "Cancelled");
        assert.equal(callbackCalls, 0, `${state} resume must not invoke the callback`);
        const diagnostics = sourceCache.getConversationSourceCacheDiagnostics();
        assert.equal(diagnostics.pinsReleased, diagnostics.pinsCreated, `${state} resume must release its owner cache pin`);
    }
}

async function testCacheGenerationPinsBeforeFirstSpoolAwait(): Promise<void> {
    sourceCache.resetConversationSourceCacheForTests();
    sourceCache.setConversationSourceCacheDataRootForTests(dataRoot);
    const source = createSource("cache-generation-race");
    const cacheKey = { source: "codex", conversationId: source.conversationId };
    const fingerprint = { revision: "cache-generation-race-v1" };
    const cached = await sourceCache.readOrBuildConversationSourceCache({
        key: cacheKey,
        fingerprint,
        build: () => ({
            snapshot: { conversationId: source.conversationId, revision: source.revision },
            rounds: [{ roundIndex: 1 }, { roundIndex: 2 }, { roundIndex: 3 }],
        }),
        getRoundNumber: round => round.roundIndex,
    });
    const cacheGeneration = { key: cacheKey, generation: cached.generation, fingerprint };
    const control = controlModule.createRecordSchedulerControl({ dataRoot });
    const writeImmutable = control.spool.writeImmutable.bind(control.spool);
    let scanCompleted = false;
    let cacheRotated = false;
    control.spool.writeImmutable = async input => {
        if (scanCompleted && !cacheRotated) {
            cacheRotated = true;
            for (const revision of ["cache-generation-race-v2", "cache-generation-race-v3"]) {
                await sourceCache.readOrBuildConversationSourceCache({
                    key: cacheKey,
                    fingerprint: { revision },
                    build: () => ({
                        snapshot: { conversationId: source.conversationId, revision },
                        rounds: [{ roundIndex: 1 }],
                    }),
                    getRoundNumber: round => round.roundIndex,
                });
            }
        }
        return writeImmutable(input);
    };
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: "record-scheduler-runtime-resume-cache-generation-race",
        now: testNow,
        control,
        productionSourceReader: {
            scan: async () => {
                scanCompleted = true;
                return {
                    ...completeScan(source),
                    cacheGeneration,
                    cacheSourceSnapshot: { conversationId: source.conversationId, generation: cached.generation },
                };
            },
        } as never,
        executeForTest: async () => "cache-generation-race-complete",
    });
    const request = admissionRequest("cache-generation-race", [source], discoveryInput("cache-generation-race", [source]));
    const admitted = await runtime.admit(request);
    assert.notEqual(admitted.outcome, "UnknownOutcome");
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    const terminal = await runtime.waitForTerminal(admitted.taskId, 15);
    assert.equal(terminal?.state, "Succeeded");
    assert.equal(cacheRotated, true, "test must rotate the generation during the first source spool write");
    const frozen = await runtime.readFrozenSources(admitted.taskId);
    assert.equal(frozen.sources[0]?.cacheGeneration?.generation, cached.generation);
    const diagnostics = sourceCache.getConversationSourceCacheDiagnostics();
    assert.equal(diagnostics.pinsCreated, 1, "complete source must pin its generation before the first spool await");
    assert.equal(diagnostics.pinsReleased, 1, "terminal completion must release the early generation pin");
}

const tests: Array<[string, () => Promise<void>]> = [
    ["initial execution acquires scheduler owner and succeeds", testInitialExecutionAcquiresOwnerAndSucceeds],
    ["slow execution heartbeats short owner lease and stops after settlement", testSlowExecutionHeartbeatsOwnerLeaseAndStopsAfterSettlement],
    ["old returning callback is fenced after owner takeover", testOldReturningCallbackIsFencedAfterTakeover],
    ["old throwing callback is fenced after owner takeover", testOldThrowingCallbackIsFencedAfterTakeover],
    ["OWNER_UNAVAILABLE leaves ledger recoverable", testOwnerUnavailableLeavesLedgerRecoverable],
    ["pending discovery resumes from matching descriptor and seals sources", testPendingDiscoveryResumeUsesDescriptorAndSeals],
    ["pending discovery survives successive owner restarts before spool creation", testPendingDiscoverySurvivesSuccessiveOwnerRestartsWithoutSpool],
    ["pending discovery cancellation does not publish spool evidence", testPendingDiscoveryCancellationDoesNotPublishSpool],
    ["frozen candidate with source intent settles Deferred without live source reads", testFrozenCandidateIntentSettlesDeferredWithoutLiveSourceRead],
    ["mismatched recovery descriptor fails closed before live reads", testMismatchedRecoveryDescriptorFailsClosed],
    ["active recovery without descriptor fails before evidence or callback", testActiveRecoveryWithoutDescriptorFailsBeforeEvidenceOrCallback],
    ["sealed frozen source resumes without live discovery and runs callback", testResumeUsesSealedFrozenSourceAndRunsCallback],
    ["authoritative ledger resumes Queued, Running, and Committing without duplicate callbacks", testAuthoritativeLedgerNonterminalResumeMatrix],
    ["known terminal does not execute again", testKnownTerminalDoesNotExecute],
    ["Deferred terminal resume remains ledger read-only", testDeferredTerminalResumeRemainsReadOnly],
    ["CancelRequested runs cancellation boundary without execution", testCancelRequestedDoesNotExecute],
    ["unresolved frozen source settles Deferred", testUnresolvedFrozenSourcesSettleDeferred],
    ["discovery unresolved settles Deferred instead of false no-op", testDiscoveryUnresolvedSettlesDeferredWithoutFalseNoop],
    ["admitted suspension wake reuses frozen discovery and source evidence", testAdmittedSuspensionWakeReusesFrozenEvidence],
    ["callback errors settle FailedFinal or RepairRequired", testCallbackErrorsSettleFailedFinalOrRepairRequired],
    ["cache generation survives frozen resume and releases pin", testCacheGenerationSurvivesFrozenResumeAndReleasesPin],
    ["cache generation pins before first spool await", testCacheGenerationPinsBeforeFirstSpoolAwait],
    ["foreign live owner blocks before recovery descriptor factory or evidence reads", testForeignOwnerBlocksBeforeRecoveryPreparation],
    ["lazy descriptor factory failures fail closed", testLazyDescriptorFactoryFailuresFailClosed],
    ["lazy descriptor factory heartbeats and fences after takeover", testLazyDescriptorFactoryHeartbeatsAndFencesAfterTakeover],
    ["fallback adapter uses fresh scan ids for Lost rechecks", testFallbackAdapterUsesFreshScanIdsForLostRechecks],
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
    await waitForBackgroundQueueIdle();
    if (failures.length > 0) {
        throw new AggregateError(failures.map(item => item.error), `${failures.length} runtime resume assertion(s) failed: ${failures.map(item => item.name).join("; ")}`);
    }
} finally {
    sourceCache.resetConversationSourceCacheForTests();
    sourceCache.setConversationSourceCacheDataRootForTests(undefined);
    if (originalDataRoot === undefined) delete process.env.MEMORY_STORE_DATA_ROOT;
    else process.env.MEMORY_STORE_DATA_ROOT = originalDataRoot;
    fs.rmSync(dataRoot, { recursive: true, force: true });
}
