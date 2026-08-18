import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RecordSourceIdentity } from "../src/record-discovery.ts";
import type { RecordModelCallResult, RecordSchedulerModelCallContext } from "../src/record-types.ts";
import type { SourceEvidenceHost } from "../src/source-evidence-contracts.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-unknown-outcome-retry-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const {
    buildRecordIndexEntry,
    buildRecordIndexScope,
} = await import("../src/record-discovery.ts");
const {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
} = await import("../src/source-evidence-contracts.ts");
const { createRecordSchedulerRuntime, recordSchedulerRequestKey } = await import("../src/record-scheduler-runtime.ts");
const { createRecordSchedulerControl } = await import("../src/record-scheduler-control.ts");
const { createRecordSchedulerSpool } = await import("../src/record-scheduler-spool.ts");
const { readRecordSchedulerLedgerStore } = await import("../src/record-scheduler-store.ts");
const { readRecordWorkRegistry } = await import("../src/record-work-registry.ts");
const { createRecordSchedulerCoordinatorTestClockForTest } = await import("../src/record-scheduler-coordinator-store.ts");
const { ProviderTransportAdapter } = await import("../src/provider-transport-adapter.ts");
const { RecordSchedulerProductionPump } = await import("../src/record-scheduler-production-pump.ts");

interface Deferred<Value> {
    promise: Promise<Value>;
    resolve(value: Value): void;
}

function deferred<Value>(): Deferred<Value> {
    let resolvePromise!: (value: Value) => void;
    return {
        promise: new Promise<Value>(resolve => { resolvePromise = resolve; }),
        resolve(value: Value) {
            resolvePromise(value);
        },
    };
}

function sleep(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 1_500; index += 1) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(message);
}

function sourceFixture(conversationId: string): RecordSourceIdentity {
    return {
        host: "codex",
        identity: {
            workspace: { workspaceId: "workspace-unknown-outcome", canonicalPath: "C:/fixtures/unknown-outcome" },
            source: {
                kind: "filesystem",
                authority: "C:/fixtures/unknown-outcome/authority",
                authoritativeRoot: "C:/fixtures/unknown-outcome/authority",
                canonicalPath: "C:/fixtures/unknown-outcome/store",
            },
            conversationId,
        },
    };
}

function discoveryInputFor(source: RecordSourceIdentity) {
    const observedAt = "2026-07-14T00:00:00.000Z";
    const enumeration = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
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
    const scope = buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `index-${source.identity.conversationId}`,
        indexRevision: "index-revision-1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
    const entry = buildRecordIndexEntry({
        recordId: `record-${source.identity.conversationId}`,
        source,
        indexSnapshotId: scope.snapshotId,
        indexRevision: scope.indexRevision,
        coveredRevision: { revision: "rev-1", sequence: 1 },
        recordBodyHash: `sha256:${createHash("sha256").update(source.identity.conversationId).digest("hex")}`,
        extensions: {},
    });
    return {
        request: { snapshotId: `snapshot-${source.identity.conversationId}`, discoveredAtSequence: 2, filters: { hosts: [], workspace: null, extensions: {} } },
        sourceEnumerations: [{ evidence: enumeration, revisionSequence: 2, title: source.identity.conversationId }],
        recordIndex: { scopes: [scope], entries: [entry] },
    };
}

function productionReaderFor(source: RecordSourceIdentity) {
    return {
        async scan(request: { host: SourceEvidenceHost; conversationId: string }) {
            assert.equal(request.host, source.host);
            assert.equal(request.conversationId, source.identity.conversationId);
            const observedAt = "2026-07-14T00:00:00.000Z";
            const document = {
                schemaVersion: "record-source-content/v1" as const,
                formatterVersion: "canonical-json-nfc-lf/v1" as const,
                source: { host: source.host, conversationId: source.identity.conversationId },
                messages: [
                    { order: 1, role: "user" as const, content: source.identity.conversationId },
                    { order: 2, role: "assistant" as const, content: "fixture response" },
                ],
            };
            const bytes = Buffer.from(JSON.stringify(document), "utf8");
            const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
            const enumeration = buildSourceEnumerationEvidence({
                adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
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
            const exactFetch = buildExactFetchEvidence({
                adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
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
            const fullEvidence = buildFullSourceReadEvidence({
                adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
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
                content: { mode: "full", byteLength: bytes.byteLength, contentHash, roundRange: { start: 1, end: 2 }, truncated: false, staleCache: false },
            });
            return {
                host: source.host,
                scanId: enumeration.observedAt.scanId,
                enumeration,
                exactFetch,
                fullSourceRead: {
                    status: "complete" as const,
                    evidence: fullEvidence,
                    payload: { schemaVersion: document.schemaVersion, formatterVersion: document.formatterVersion, mediaType: "application/vnd.memory-store.record-source+json" as const, encoding: "utf-8" as const, bytes, byteLength: bytes.byteLength, contentHash },
                    sourceSnapshot: null,
                    authority: {
                        identityHash: createHash("sha256").update(canonicalSerialize(source.identity)).digest("hex"),
                        revisionHash: createHash("sha256").update(enumeration.sourceRevision.revision).digest("hex"),
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
                classification: { state: "Present" as const, reason: "unknown-outcome-fixture" },
                qualifiedAbsence: null,
            };
        },
    };
}

const spool = createRecordSchedulerSpool({ dataRoot });
const control = createRecordSchedulerControl({ dataRoot, spool });
const source = sourceFixture("unknown-outcome-retry");
const runtimeHold = deferred<void>();
let captured: any;
const runtime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "unknown-outcome-task-owner",
    control,
    sourceEvidenceAdapter: { buildDiscoveryInput: async () => discoveryInputFor(source) as never },
    productionSourceReader: productionReaderFor(source) as never,
    executeForTest: async request => {
        captured = request;
        await runtimeHold.promise;
        return "unknown-outcome retry fixture held";
    },
});
const summary = { operation: "record-update", workspaceHash: "unknown-outcome-retry", dataChain: "codex", modelChain: "grok" };
const admission = await runtime.admit({
    kind: "record-update",
    requestKey: recordSchedulerRequestKey("record-update", summary),
    requestSummary: summary,
    resumePayload: { kind: "record-update", workspace: dataRoot },
    requestMode: "normal",
    discovery: { kind: "record-update", selector: "normal", input: discoveryInputFor(source) as never },
    execute: async () => "must not run in test mode",
});
assert.equal(admission.outcome, "Admitted");
if (admission.outcome === "UnknownOutcome") throw new Error(admission.reasons.join("; "));
await waitFor(() => captured !== undefined, "runtime must capture the sealed frozen source set");

const registration = {
    taskId: admission.taskId,
    frozenSources: captured.sourceSnapshots,
    sourceSnapshotId: captured.sourceSnapshots.sources[0].snapshot.sourceSnapshotId,
    recordStoreHash: captured.sourceSnapshots.sources[0].snapshot.workspaceHash,
    schedulerOwner: { ownerId: "unknown-outcome-task-owner", leaseMs: 120_000, workLeaseMs: 120_000 },
    control,
    spool,
    firstPublicationToken: "unknown-outcome-first-publication",
};

let nowMs = Date.now() + 60_000;
const coordinatorClock = createRecordSchedulerCoordinatorTestClockForTest(() => nowMs);
const identities = new Map<string, {
    provider: "grok" | "agy";
    trafficClass: "record";
    attemptId: string;
    leaseId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAt: number;
    expiresAt: number;
}>();
const providerAdmission = {
    async acquire(provider: "grok" | "agy", trafficClass: "record", invocation: { attemptId: string }) {
        const identity = {
            provider,
            trafficClass,
            attemptId: invocation.attemptId,
            leaseId: `unknown-outcome-lease-${invocation.attemptId}`,
            ownerEpoch: 1,
            capacityGeneration: 1,
            acquiredAt: nowMs,
            expiresAt: nowMs + 120_000,
        } as const;
        identities.set(identity.attemptId, identity);
        return {
            leaseId: identity.leaseId,
            leaseIdentity: identity,
            async assertCurrent() {},
            async complete() {
                identities.delete(identity.attemptId);
                return true;
            },
        };
    },
    async tryAcquire(provider: "grok" | "agy", trafficClass: "record", invocation: { attemptId: string }) {
        return await this.acquire(provider, trafficClass, invocation);
    },
    async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
        const identity = identities.get(attemptId);
        return identity && identity.provider === provider
            ? { kind: "uncertain" as const, identity }
            : { kind: "absent" as const };
    },
    async settleRecoveredLease(identity: { attemptId: string }) {
        identities.delete(identity.attemptId);
        return { kind: "settled" as const };
    },
    async cancelRecoveredLease(identity: { attemptId: string }) {
        identities.delete(identity.attemptId);
        return { kind: "settled" as const };
    },
    async snapshot() {
        return {};
    },
};
const transport = new ProviderTransportAdapter({ mode: "test", admission: providerAdmission as never });
const invocationOptions: Array<{ attemptId: string; idempotencyKey: string }> = [];
const retryPhases: any[] = [];

function pump(onPhase?: (event: any) => void | Promise<void>) {
    return new RecordSchedulerProductionPump({
        coordinatorOwnerId: "unknown-outcome-coordinator",
        coordinatorLeaseMs: 1,
        coordinatorStore: { dataRoot, testClock: coordinatorClock },
        providerTransport: transport,
        clock: { nowMs: () => nowMs },
        onPhase,
    });
}

function modelCall(run: () => Promise<RecordModelCallResult>, logicalCallKey = "unknown-outcome-retry-logical-call"): RecordSchedulerModelCallContext {
    const invoke: RecordSchedulerModelCallContext["invoke"] = async options => {
        assert.ok(options?.transportLease, "production provider invocation must retain its transport lease");
        assert.ok(options.attemptId, "production provider invocation must receive attemptId");
        assert.ok(options.idempotencyKey, "production provider invocation must receive ledger idempotencyKey");
        assert.equal(options.transportLease.attemptId, options.attemptId);
        invocationOptions.push({ attemptId: options.attemptId, idempotencyKey: options.idempotencyKey });
        return await transport.executeGranted(
            options.transportLease,
            run,
            result => result.text === null ? "failure" : "success",
            () => "unknown",
        );
    };
    return {
        logicalCallKey,
        provider: "grok",
        model: "unknown-outcome-retry-model",
        prompt: "unknown outcome retry prompt",
        logicalTimeout: 1_000,
        routePlan: ["grok"],
        providerCalls: [{
            provider: "grok",
            model: "unknown-outcome-retry-model",
            logicalTimeout: 1_000,
            invokeTimeout: 1_000,
            invoke,
            invokePrompt: async (_prompt, options) => await invoke(options),
        }],
        recipe: {
            recipeVersion: 1,
            templateId: "unknown-outcome-retry/v1",
            range: { axis: "round", start: 1, end: 2 },
            composeOrder: 0,
        },
        retryBudget: 1,
        splitPrompt: range => `unknown outcome retry prompt rounds ${range.start}-${range.end}`,
        invokeTimeout: 1_000,
        retryOrdinal: 0,
        trafficClass: "record-batch",
        context: { requestedChain: "grok", background: true, providerTrafficClass: "record", grokContext: "record" },
        invoke,
    };
}

const originalPump = pump();
let originalSettled = false;
let originalFailure: unknown;
const original = originalPump.submit(registration, modelCall(async () => {
    throw new Error("provider response lost after RPC start");
}));
void original.then(
    () => { originalSettled = true; },
    error => {
        originalFailure = error;
        originalSettled = true;
    },
);
await waitFor(
    () => invocationOptions.length === 1 || originalSettled,
    "first provider attempt must start or fail explicitly before restart recovery",
);
if (invocationOptions.length !== 1) {
    const stalled = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
    throw new Error(
        `first provider attempt failed before invoke: ${originalFailure instanceof Error ? `${originalFailure.name}:${originalFailure.message}` : String(originalFailure)}; durable=${JSON.stringify(stalled)}`,
    );
}
assert.match(invocationOptions[0].attemptId, /:attempt:1$/u);
await assert.rejects(
    () => original,
    /provider response lost after RPC start/u,
);
await originalPump.quiesce();
const recovered = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(recovered.kind, "current");
if (recovered.kind !== "current") throw new Error("recovered scheduler ledger missing");
const firstAttempt = recovered.ledger.attempts.find(attempt => attempt.attemptId === invocationOptions[0].attemptId);
assert.equal(firstAttempt?.state, "UnknownOutcome");
assert.equal(firstAttempt?.unknownOutcomeGraceMs, 30_000);
assert.equal(Date.parse(firstAttempt?.unknownOutcomeUntil || "") - Date.parse(firstAttempt?.unknownOutcomeAt || ""), 30_000);
const registryLocation = {
    dataRoot,
    identity: {
        chain: source.host,
        workspaceHash: registration.recordStoreHash,
        conversationId: source.identity.conversationId,
    },
};
const firstRegistry = await readRecordWorkRegistry(registryLocation);
assert.equal(firstRegistry.kind, "ready");
if (firstRegistry.kind !== "ready") throw new Error("UnknownOutcome registry missing after first attempt");
const firstSchedulerWork = recovered.ledger.recordWork.find(work => work.recordWorkKey === firstAttempt?.recordWorkKey);
const firstRegistryWork = firstRegistry.registry.works.find(work => work.recordWorkKey === firstAttempt?.recordWorkKey);
assert.ok(firstSchedulerWork && firstRegistryWork?.ownerLease, "scheduler and registry work must both exist");
assert.deepEqual({
    schedulerEpoch: firstSchedulerWork?.schedulerEpoch,
    recordCommitEpoch: firstSchedulerWork?.recordCommitEpoch,
    fencingToken: firstSchedulerWork?.currentFencingToken,
    workLeaseId: firstSchedulerWork?.workLeaseId,
}, firstAttempt?.fence, "first provider Attempt must use the authoritative registry fence");
assert.equal(firstRegistryWork?.currentFencingToken, firstAttempt?.fence.fencingToken);
assert.equal(firstRegistryWork?.ownerLease?.workLeaseId, firstAttempt?.fence.workLeaseId);

nowMs += 29_999;
const withinWindowPump = pump();
await assert.rejects(
    () => withinWindowPump.submit(registration, modelCall(async () => ({ text: "must-not-run-within-window" }))),
    error => (error as { code?: unknown }).code === "UNKNOWN_OUTCOME",
);
assert.equal(invocationOptions.length, 1, "29,999ms grace window must block a second provider dispatch");

nowMs += 1;
const retryPump = pump(event => { retryPhases.push(event); });
const retryResult = await retryPump.submit(registration, modelCall(async () => ({
    text: "retry-result",
    chainUsed: "grok",
    modelUsed: "unknown-outcome-retry-model",
})));
assert.equal(retryResult.text, "retry-result");
assert.equal(invocationOptions.length, 2, "30,000ms grace boundary must create and dispatch a new Attempt");
assert.match(invocationOptions[1].attemptId, /:attempt:2$/u);
assert.notEqual(invocationOptions[1].idempotencyKey, invocationOptions[0].idempotencyKey);

const afterRetry = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(afterRetry.kind, "current");
if (afterRetry.kind !== "current") throw new Error("retry scheduler ledger missing");
const discarded = afterRetry.ledger.attempts.find(attempt => attempt.attemptId === invocationOptions[0].attemptId);
const retried = afterRetry.ledger.attempts.find(attempt => attempt.attemptId === invocationOptions[1].attemptId);
assert.equal(discarded?.state, "Discarded");
assert.equal(retried?.state, "KnownSuccess");
assert.notEqual(discarded?.fence.fencingToken, retried?.fence.fencingToken);
assert.notEqual(discarded?.idempotencyKey, retried?.idempotencyKey);
assert.equal(afterRetry.ledger.units.find(unit => unit.unitId === retried?.unitId)?.state, "ResultReady");
assert.equal(afterRetry.ledger.units.find(unit => unit.unitId === retried?.unitId)?.retryBudget, 0, "the only UnknownOutcome retry budget must be consumed");
const retryRegistry = await readRecordWorkRegistry(registryLocation);
assert.equal(retryRegistry.kind, "ready");
if (retryRegistry.kind !== "ready") throw new Error("retry registry missing");
const retryRegistryWork = retryRegistry.registry.works.find(work => work.recordWorkKey === retried?.recordWorkKey);
assert.equal(retryRegistryWork?.currentFencingToken, retried?.fence.fencingToken, "retry fence must be advanced in the registry, not only in the scheduler ledger");
assert.equal(retryRegistryWork?.ownerLease?.workLeaseId, retried?.fence.workLeaseId);
const resultEvent = retryPhases.find(event => event.phase === "provider-result-received" && event.attemptId === retried?.attemptId);
const spoolEvent = retryPhases.find(event => event.phase === "output-spool-persisted" && event.attemptId === retried?.attemptId);
assert.equal(resultEvent?.idempotencyKey, retried?.idempotencyKey);
assert.equal(resultEvent?.fence.fencingToken, retried?.fence.fencingToken);
assert.ok(resultEvent?.claim?.claimId && resultEvent?.claim?.providerEvidence && resultEvent?.output?.hash);
assert.equal(spoolEvent?.idempotencyKey, retried?.idempotencyKey);
assert.equal(spoolEvent?.output?.reference?.hash, retried?.outputRef?.hash);

const staleFencePump = retryPump as unknown as {
    markKnownSuccess(prepared: unknown, claim: unknown, result: RecordModelCallResult): Promise<void>;
};
const retrySource = registration.frozenSources.sources[0];
const retryOwner = afterRetry.ledger.schedulerOwner;
assert.ok(retryOwner, "retry ledger must retain scheduler owner evidence");
await assert.rejects(
    () => staleFencePump.markKnownSuccess({
        registration,
        source: retrySource,
        ownerLease: retryOwner,
        identity: {
            chain: retrySource.snapshot.chain,
            workspaceHash: retrySource.snapshot.workspaceHash,
            conversationId: retrySource.snapshot.conversationId,
        },
        recordWorkKey: discarded?.recordWorkKey,
        unitId: discarded?.unitId,
        attemptId: discarded?.attemptId,
        idempotencyKey: discarded?.idempotencyKey,
        inputHash: discarded?.inputHash,
        provider: discarded?.provider,
        model: discarded?.model,
        call: modelCall(async () => ({ text: "must-not-invoke-late-result" })),
    }, {
        claimId: discarded?.claimId,
        permitId: discarded?.permitId,
        dispatchSeq: discarded?.dispatchSeq,
        attemptId: discarded?.attemptId,
        providerAdmission: discarded?.providerAdmission,
        providerEvidence: discarded?.providerEvidence,
        providerLeaseIdentity: discarded?.providerLeaseIdentity,
    }, {
        text: "late-old-result",
        chainUsed: "grok",
        modelUsed: "unknown-outcome-retry-model",
    }),
    error => (error as { code?: unknown }).code === "UNKNOWN_OUTCOME",
);
const afterLateResult = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(afterLateResult.kind, "current");
if (afterLateResult.kind !== "current") throw new Error("late result scheduler ledger missing");
assert.equal(afterLateResult.ledger.attempts.find(attempt => attempt.attemptId === retried?.attemptId)?.state, "KnownSuccess");
assert.equal(afterLateResult.ledger.commits.length, 0, "late provider result must not create a commit");
await retryPump.quiesce();
await withinWindowPump.quiesce();
nowMs += 2;

const handoffKey = "unknown-outcome-owner-handoff";
const handoffFirstPump = pump();
await assert.rejects(
    () => handoffFirstPump.submit(registration, modelCall(async () => {
        throw new Error("owner handoff response lost");
    }, handoffKey)),
    /owner handoff response lost/u,
);
await handoffFirstPump.quiesce();
const handoffFirstAttemptId = invocationOptions.at(-1)?.attemptId;
assert.ok(handoffFirstAttemptId, "owner handoff first Attempt must invoke provider");
const handoffUnknownRead = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(handoffUnknownRead.kind, "current");
if (handoffUnknownRead.kind !== "current") throw new Error("owner handoff UnknownOutcome ledger missing");
const handoffUnknownAttempt = handoffUnknownRead.ledger.attempts.find(attempt => attempt.attemptId === handoffFirstAttemptId);
assert.equal(handoffUnknownAttempt?.state, "UnknownOutcome");
const handoffRecoveryNow = nowMs + 200_000;
const ownerB = await control.recoverOwner({
    taskId: admission.taskId,
    ownerId: "unknown-outcome-task-owner-b",
    nowMs: handoffRecoveryNow,
    leaseMs: 120_000,
    workLeaseMs: 120_000,
});
assert.equal(
    ownerB.kind,
    "recovered",
    `expired owner handoff must reacquire scheduler and registry leases; recovery=${JSON.stringify(ownerB)}`,
);
if (ownerB.kind !== "recovered") throw new Error(`owner handoff failed: ${ownerB.reason}`);
nowMs = handoffRecoveryNow;
const afterOwnerRecovery = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(afterOwnerRecovery.kind, "current");
if (afterOwnerRecovery.kind !== "current") throw new Error("owner handoff ledger missing");
const recoveredHandoffWork = afterOwnerRecovery.ledger.recordWork.find(work => work.recordWorkKey === handoffUnknownAttempt?.recordWorkKey);
const preservedUnknown = afterOwnerRecovery.ledger.attempts.find(attempt => attempt.attemptId === handoffFirstAttemptId);
assert.ok(recoveredHandoffWork && preservedUnknown, "owner recovery must preserve the UnknownOutcome evidence");
assert.equal(recoveredHandoffWork?.currentFencingToken, handoffUnknownAttempt?.fence.fencingToken, "scheduler owner handoff must preserve the logical work fencing token");
assert.equal(recoveredHandoffWork?.workLeaseId, handoffUnknownAttempt?.fence.workLeaseId, "scheduler owner handoff must preserve the logical work lease lineage");
assert.ok((recoveredHandoffWork?.schedulerEpoch || 0) > (handoffUnknownAttempt?.fence.schedulerEpoch || 0), "scheduler owner handoff must advance only the scheduler owner epoch");
assert.deepEqual(preservedUnknown?.fence, {
    schedulerEpoch: recoveredHandoffWork?.schedulerEpoch,
    recordCommitEpoch: recoveredHandoffWork?.recordCommitEpoch,
    fencingToken: recoveredHandoffWork?.currentFencingToken,
    workLeaseId: recoveredHandoffWork?.workLeaseId,
});
const ownerBRegistration = {
    ...registration,
    schedulerOwner: { ownerId: "unknown-outcome-task-owner-b", leaseMs: 120_000, workLeaseMs: 120_000 },
};
const handoffFenceBeforeRetry = recoveredHandoffWork?.currentFencingToken;
const handoffRetryPump = pump();
const handoffResult = await handoffRetryPump.submit(ownerBRegistration, modelCall(async () => ({
    text: "owner-handoff-retry-result",
    chainUsed: "grok",
    modelUsed: "unknown-outcome-retry-model",
}), handoffKey));
assert.equal(handoffResult.text, "owner-handoff-retry-result");
const handoffRetryAttemptId = invocationOptions.at(-1)?.attemptId;
const handoffRetryRead = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(handoffRetryRead.kind, "current");
if (handoffRetryRead.kind !== "current") throw new Error("owner handoff retry ledger missing");
const handoffRetryAttempt = handoffRetryRead.ledger.attempts.find(attempt => attempt.attemptId === handoffRetryAttemptId);
assert.equal(handoffRetryAttempt?.fence.fencingToken, (handoffFenceBeforeRetry || 0) + 1, "UnknownOutcome retry must rotate the logical work fence exactly once after owner handoff");
await handoffRetryPump.quiesce();
nowMs += 2;

const exhaustedKey = "unknown-outcome-budget-exhaustion";
const invocationCountBeforeExhaustion = invocationOptions.length;
const exhaustedFirstPump = pump();
await assert.rejects(
    () => exhaustedFirstPump.submit(ownerBRegistration, modelCall(async () => {
        throw new Error("unknown outcome one");
    }, exhaustedKey)),
    /unknown outcome one/u,
);
await exhaustedFirstPump.quiesce();
nowMs += 30_000;
const exhaustedSecondPump = pump();
await assert.rejects(
    () => exhaustedSecondPump.submit(ownerBRegistration, modelCall(async () => {
        throw new Error("unknown outcome two");
    }, exhaustedKey)),
    /unknown outcome two/u,
);
await exhaustedSecondPump.quiesce();
assert.equal(invocationOptions.length, invocationCountBeforeExhaustion + 2, "one initial call and one budgeted retry must reach the provider");
nowMs += 30_000;
let thirdInvocationRan = false;
const exhaustedThirdPump = pump();
await assert.rejects(
    () => exhaustedThirdPump.submit(ownerBRegistration, modelCall(async () => {
        thirdInvocationRan = true;
        return { text: "must-not-run-third", chainUsed: "grok", modelUsed: "unknown-outcome-retry-model" };
    }, exhaustedKey)),
    error => (error as { code?: unknown }).code === "UNKNOWN_OUTCOME" && /预算已耗尽/u.test((error as Error).message),
);
assert.equal(thirdInvocationRan, false, "a second UnknownOutcome expiry must not create a third provider call");
assert.equal(invocationOptions.length, invocationCountBeforeExhaustion + 2);
const exhaustedRead = await readRecordSchedulerLedgerStore(admission.taskId, { expectPublished: true });
assert.equal(exhaustedRead.kind, "current");
if (exhaustedRead.kind !== "current") throw new Error("exhausted UnknownOutcome ledger missing");
const exhaustedAttemptIds = invocationOptions.slice(invocationCountBeforeExhaustion).map(item => item.attemptId);
const exhaustedAttempts = exhaustedRead.ledger.attempts.filter(attempt => exhaustedAttemptIds.includes(attempt.attemptId));
assert.equal(exhaustedAttempts.length, 2);
assert.ok(exhaustedAttempts.every(attempt => attempt.state === "Discarded" && attempt.errorClass === "UnknownOutcome"));
const exhaustedUnit = exhaustedRead.ledger.units.find(unit => unit.unitId === exhaustedAttempts[0]?.unitId);
assert.equal(exhaustedUnit?.state, "FailedFinal");
assert.equal(exhaustedUnit?.failureClass, "UnknownOutcome");
assert.equal(exhaustedUnit?.retryBudget, 0);

runtimeHold.resolve(undefined);
console.log("record scheduler UnknownOutcome retry tests passed");
