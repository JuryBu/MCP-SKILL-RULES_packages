import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RecordSourceIdentity } from "../src/record-discovery.ts";
import type { SourceEvidenceHost } from "../src/source-evidence-contracts.ts";
import type { RecordModelCallResult, RecordSchedulerModelCallContext } from "../src/record-types.ts";
import type { ProviderTrafficClass } from "../src/provider-control-contracts.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const { buildRecordIndexEntry, buildRecordIndexScope } = await import("../src/record-discovery.ts");
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
const {
    getBackgroundTask,
    getBackgroundTaskQueueLaneStatsForTest,
    getBackgroundTaskQueueStatsForTest,
    isBackgroundTaskSuspension,
} = await import("../src/background-tasks.ts");
const { mutateRecordSchedulerLedgerAsOwner, readRecordSchedulerLedgerStore } = await import("../src/record-scheduler-store.ts");
const {
    createRecordSchedulerCoordinatorTestClockForTest,
    initializeRecordSchedulerCoordinatorStore,
    readRecordSchedulerCoordinatorStore,
} = await import("../src/record-scheduler-coordinator-store.ts");
const { RecordSchedulerCoordinator } = await import("../src/record-scheduler-coordinator.ts");
const { ProviderTransportAdapter } = await import("../src/provider-transport-adapter.ts");
const {
    calculateRecordSchedulerRestartElapsedMs,
    RecordSchedulerProductionPump,
    closeRecordSchedulerProductionSessions,
    createRecordSchedulerProductionSession,
    getRecordSchedulerProductionPump,
    quiesceRecordSchedulerProductionSessions,
} = await import("../src/record-scheduler-production-pump.ts");

assert.equal(calculateRecordSchedulerRestartElapsedMs("2026-07-15T00:00:00.000Z", Date.parse("2026-07-15T00:00:05.000Z"), 10_000), 5_000);
assert.equal(calculateRecordSchedulerRestartElapsedMs("2026-07-15T00:00:00.000Z", Date.parse("2026-07-15T00:02:00.000Z"), 60_000), 60_000);
assert.equal(calculateRecordSchedulerRestartElapsedMs("2026-07-15T00:00:01.000Z", Date.parse("2026-07-15T00:00:00.000Z"), 60_000), 0);
assert.equal(calculateRecordSchedulerRestartElapsedMs("invalid", Date.parse("2026-07-15T00:00:00.000Z"), 60_000), 0);
assert.equal(calculateRecordSchedulerRestartElapsedMs("2026-07-15T00:00:00.000Z", Number.NaN, 60_000), 0);

const restartCreditDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-restart-credit-"));
let restartCreditNowMs = Date.parse("2026-07-15T00:00:00.000Z");
const restartCreditStoreClock = createRecordSchedulerCoordinatorTestClockForTest(() => restartCreditNowMs);
const restartCreditCoordinator = new RecordSchedulerCoordinator();
await restartCreditCoordinator.rebuild([]);
const restartCreditSnapshot = restartCreditCoordinator.snapshot();
const restartCreditBaseline = restartCreditSnapshot.fairness.logicalNowMs;
await initializeRecordSchedulerCoordinatorStore({
    dataRoot: restartCreditDataRoot,
    testClock: restartCreditStoreClock,
    snapshot: JSON.parse(JSON.stringify(restartCreditSnapshot)),
});
restartCreditNowMs += 5_000;
const restartCreditPump = new RecordSchedulerProductionPump({
    coordinatorOwnerId: "restart-credit-owner",
    coordinatorLeaseMs: 60_000,
    coordinatorRestartCreditCapMs: 250,
    coordinatorStore: { dataRoot: restartCreditDataRoot, testClock: restartCreditStoreClock },
    clock: { nowMs: () => restartCreditNowMs },
});
await (restartCreditPump as any).openCoordinatorSession();
const restartCreditFirst = await readRecordSchedulerCoordinatorStore({ dataRoot: restartCreditDataRoot });
assert.equal(restartCreditFirst.kind, "current");
assert.equal(
    restartCreditFirst.kind === "current" ? restartCreditFirst.snapshot.fairness.logicalNowMs : -1,
    restartCreditBaseline + 250,
    "fresh coordinator owner must inject the clamped downtime credit",
);
restartCreditNowMs += 1_000;
await (restartCreditPump as any).openCoordinatorSession();
const restartCreditSecond = await readRecordSchedulerCoordinatorStore({ dataRoot: restartCreditDataRoot });
assert.equal(restartCreditSecond.kind, "current");
assert.equal(
    restartCreditSecond.kind === "current" ? restartCreditSecond.snapshot.fairness.logicalNowMs : -1,
    restartCreditBaseline + 250,
    "same owner epoch must not inject restart credit again",
);
await restartCreditPump.close({ timeoutMs: 5_000 });

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
    readonly settled: boolean;
}

function deferred<T>(): Deferred<T> {
    let resolvePromise!: (value: T) => void;
    let settled = false;
    const promise = new Promise<T>(resolve => { resolvePromise = resolve; });
    return {
        promise,
        resolve(value: T) {
            if (settled) return;
            settled = true;
            resolvePromise(value);
        },
        get settled() {
            return settled;
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
    for (let index = 0; index < 1_000; index += 1) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(message);
}

function fixtureSource(conversationId: string): RecordSourceIdentity {
    return {
        host: "codex",
        identity: {
            workspace: { workspaceId: "workspace-production-pump", canonicalPath: "C:/fixtures/production-pump" },
            source: {
                kind: "filesystem",
                authority: "C:/fixtures/production-pump/authority",
                authoritativeRoot: "C:/fixtures/production-pump/authority",
                canonicalPath: "C:/fixtures/production-pump/store",
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
                classification: { state: "Present" as const, reason: "production-pump-fixture" },
                qualifiedAbsence: null,
            };
        },
    };
}

const sourceA = fixtureSource("production-pump-a");
const sourceB = fixtureSource("production-pump-b");
interface PumpFixture {
    label: string;
    dataRoot: string;
    spool: ReturnType<typeof createRecordSchedulerSpool>;
    control: ReturnType<typeof createRecordSchedulerControl>;
    captures: Map<string, any>;
    runtimeHolds: Map<string, Deferred<void>>;
}

const pumpFixtures: PumpFixture[] = [];

function createPumpFixture(root: string, label = path.basename(root)): PumpFixture {
    const spool = createRecordSchedulerSpool({ dataRoot: root });
    const fixture: PumpFixture = {
        label,
        dataRoot: root,
        spool,
        control: createRecordSchedulerControl({ dataRoot: root, spool }),
        captures: new Map<string, any>(),
        runtimeHolds: new Map<string, ReturnType<typeof deferred<void>>>(),
    };
    pumpFixtures.push(fixture);
    return fixture;
}

const mainFixture = createPumpFixture(dataRoot);
const { spool, control, captures, runtimeHolds } = mainFixture;

type FixtureRuntimeTaskKind = "record-update" | "record-batch-update";

function backgroundTaskDiagnostics() {
    return {
        queue: getBackgroundTaskQueueStatsForTest(),
        lanes: getBackgroundTaskQueueLaneStatsForTest(),
        fixtureTasks: pumpFixtures.flatMap(fixture => [...fixture.runtimeHolds.entries()].map(([taskId, hold]) => {
            const task = getBackgroundTask(taskId);
            return {
                fixture: fixture.label,
                taskId,
                holdSettled: hold.settled,
                captured: fixture.captures.has(taskId),
                kind: task?.kind ?? null,
                status: task?.status ?? null,
                stage: task?.progress?.stage ?? null,
                error: task?.error ?? null,
            };
        })),
    };
}

async function releaseRuntimeHoldAndWait(
    fixture: PumpFixture,
    taskId: string,
    label: string,
): Promise<void> {
    const hold = fixture.runtimeHolds.get(taskId);
    assert.ok(hold, `${label} must have captured its execute callback before it can be released`);
    hold.resolve(undefined);
    try {
        await waitFor(() => getBackgroundTask(taskId)?.status !== "running", `${label} did not leave the background queue after its runtime hold was released`);
    } catch {
        throw new Error(`${label} did not settle after release: ${JSON.stringify(backgroundTaskDiagnostics())}`);
    }
    const task = getBackgroundTask(taskId);
    assert.equal(task?.status, "done", `${label} must finish naturally after its runtime hold is released; diagnostics=${JSON.stringify(backgroundTaskDiagnostics())}`);
}

async function admitFixture(
    source: RecordSourceIdentity,
    ownerId: string,
    fixture: PumpFixture = mainFixture,
    kind: FixtureRuntimeTaskKind = "record-update",
) {
    const runtime = createRecordSchedulerRuntime({
        mode: "test",
        ownerId,
        control: fixture.control,
        sourceEvidenceAdapter: { buildDiscoveryInput: async () => discoveryInputFor(source) as never },
        productionSourceReader: productionReaderFor(source) as never,
        executeForTest: async request => {
            const hold = deferred<void>();
            fixture.runtimeHolds.set(request.taskId, hold);
            fixture.captures.set(request.taskId, request);
            await hold.promise;
            return "production pump fixture held";
        },
    });
    const summary = { operation: kind, workspaceHash: `production-pump-${source.identity.conversationId}`, dataChain: "codex", modelChain: "grok" };
    const admission = await runtime.admit({
        kind,
        requestKey: recordSchedulerRequestKey(kind, summary),
        requestSummary: summary,
        resumePayload: { kind, workspace: fixture.dataRoot },
        requestMode: "normal",
        discovery: { kind, selector: "normal", input: discoveryInputFor(source) as never },
        execute: async () => "must not run in test mode",
    });
    assert.equal(admission.outcome, "Admitted");
    if (admission.outcome === "UnknownOutcome") throw new Error(admission.reasons.join("; "));
    try {
        await waitFor(() => fixture.captures.has(admission.taskId), `runtime did not capture ${source.identity.conversationId}`);
    } catch {
        const backgroundTask = getBackgroundTask(admission.taskId);
        throw new Error(
            `runtime did not capture ${source.identity.conversationId}; state=${runtime.status(admission.taskId)?.state ?? "missing"}; `
            + `kind=${backgroundTask?.kind ?? "missing"}; status=${backgroundTask?.status ?? "missing"}; `
            + `stage=${backgroundTask?.progress?.stage ?? "missing"}; error=${backgroundTask?.error ?? "missing"}; `
            + `diagnostics=${JSON.stringify(backgroundTaskDiagnostics())}`,
        );
    }
    const backgroundTask = getBackgroundTask(admission.taskId);
    assert.equal(backgroundTask?.kind, kind, `admitted ${source.identity.conversationId} must retain its requested background task kind`);
    assert.equal(backgroundTask?.status, "running", `admitted ${source.identity.conversationId} must remain running while its execute callback is held`);
    return { taskId: admission.taskId, sourceSet: fixture.captures.get(admission.taskId).sourceSnapshots, ownerId };
}

let acquireCount = 0;
let cancelCount = 0;
let recoveredCancelCount = 0;
let activePhysicalLeases = 0;
let faultHandler: ((event: any) => void | Promise<void>) | undefined;
const fakeLeaseIdentities = new Map<string, {
    provider: "grok" | "agy";
    trafficClass: ProviderTrafficClass;
    attemptId: string;
    leaseId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAt: number;
    expiresAt: number;
}>();
const fakeAdmission = {
    async tryAcquire(provider: "grok" | "agy", trafficClass: ProviderTrafficClass, invocation: { attemptId: string }) {
        acquireCount += 1;
        activePhysicalLeases += 1;
        const identity = {
            provider,
            trafficClass,
            attemptId: invocation.attemptId,
            leaseId: `lease-${invocation.attemptId}`,
            ownerEpoch: 1,
            capacityGeneration: 1,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
        } as const;
        fakeLeaseIdentities.set(invocation.attemptId, identity);
        return {
            leaseId: identity.leaseId,
            leaseIdentity: identity,
            async assertCurrent() {},
            async complete(outcome?: { kind: string }) {
                if (outcome?.kind === "cancelled") cancelCount += 1;
                activePhysicalLeases -= 1;
                fakeLeaseIdentities.delete(invocation.attemptId);
                return true;
            },
        };
    },
    async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
        const identity = fakeLeaseIdentities.get(attemptId);
        return identity && identity.provider === provider ? { kind: "active" as const, identity } : { kind: "absent" as const };
    },
    async settleRecoveredLease(identity: { attemptId: string }) {
        const existing = fakeLeaseIdentities.get(identity.attemptId);
        if (!existing) return { kind: "already-settled" as const };
        fakeLeaseIdentities.delete(identity.attemptId);
        activePhysicalLeases -= 1;
        return { kind: "settled" as const };
    },
    async cancelRecoveredLease(identity: { attemptId: string }) {
        recoveredCancelCount += 1;
        return await fakeAdmission.settleRecoveredLease(identity);
    },
    async snapshot() {
        return {};
    },
};
const transport = new ProviderTransportAdapter({ mode: "test", admission: fakeAdmission as never });
const phases: Array<{ phase: string; taskId: string; dispatchSeq?: number }> = [];
const pumpOptions = {
    coordinatorOwnerId: "production-pump-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot },
    providerTransport: transport,
    onPhase: async event => {
        phases.push({ phase: event.phase, taskId: event.taskId, dispatchSeq: event.claim?.dispatchSeq });
        await faultHandler?.(event);
    },
};
const pump = getRecordSchedulerProductionPump(pumpOptions);
assert.equal(getRecordSchedulerProductionPump({ ...pumpOptions }), pump, "hooks for one coordinator store must share one in-memory production pump");

const taskA = await admitFixture(sourceA, "production-pump-task-owner");
const taskB = await admitFixture(sourceB, "production-pump-task-owner");

function registration(task: { taskId: string; sourceSet: any; ownerId?: string }, fixture: PumpFixture = mainFixture) {
    return {
        taskId: task.taskId,
        frozenSources: task.sourceSet,
        sourceSnapshotId: task.sourceSet.sources[0].snapshot.sourceSnapshotId,
        recordStoreHash: task.sourceSet.sources[0].snapshot.workspaceHash,
        schedulerOwner: { ownerId: task.ownerId || "production-pump-task-owner", leaseMs: 120_000, workLeaseMs: 120_000 },
        control: fixture.control,
        spool: fixture.spool,
        firstPublicationToken: "production-pump-first-publication",
    };
}

type RouteProvider = RecordSchedulerModelCallContext["routePlan"][number];
type RouteProviderCall = RecordSchedulerModelCallContext["providerCalls"][number];
type RouteInvoke = RouteProviderCall["invoke"];
type RouteInvokePrompt = RouteProviderCall["invokePrompt"];

interface RouteProviderFixture {
    provider: RouteProvider;
    model?: string;
    logicalTimeout?: number;
    invokeTimeout?: number;
    invoke: RouteInvoke;
    invokePrompt?: RouteInvokePrompt;
}

interface RouteCallFixtureOptions {
    prompt?: string;
    providers: readonly RouteProviderFixture[];
    recipe?: RecordSchedulerModelCallContext["recipe"];
    retryBudget?: number;
    splitPrompt?: RecordSchedulerModelCallContext["splitPrompt"];
    requestedChain?: RecordSchedulerModelCallContext["context"]["requestedChain"];
}

function routeCall(
    logicalCallKey: string,
    options: RouteCallFixtureOptions,
): RecordSchedulerModelCallContext {
    const providerCalls = options.providers.map((fixture): RouteProviderCall => ({
        provider: fixture.provider,
        model: fixture.model || `fake-${fixture.provider}-record`,
        logicalTimeout: fixture.logicalTimeout || 1_000,
        invokeTimeout: fixture.invokeTimeout || 1_000,
        invoke: fixture.invoke,
        invokePrompt: fixture.invokePrompt || (async (_prompt, invokeOptions) => await fixture.invoke(invokeOptions)),
    }));
    const primary = providerCalls[0];
    if (!primary) throw new Error("route fixture requires at least one provider call");
    const prompt = options.prompt || logicalCallKey;
    const recipe = options.recipe || {
        recipeVersion: 1,
        templateId: "production-pump-route-fixture/v1",
        range: { axis: "round", start: 1, end: 4 },
        composeOrder: 0,
    };
    return {
        logicalCallKey,
        prompt,
        routePlan: providerCalls.map(providerCall => providerCall.provider),
        providerCalls,
        recipe,
        retryBudget: options.retryBudget || 0,
        splitPrompt: options.splitPrompt || (range => `${prompt}\n\n[split ${range.axis} ${range.start}-${range.end}]`),
        provider: primary.provider,
        model: primary.model,
        logicalTimeout: primary.logicalTimeout,
        invokeTimeout: primary.invokeTimeout,
        retryOrdinal: 0,
        invoke: primary.invoke,
        trafficClass: "record-batch",
        context: { requestedChain: options.requestedChain || primary.provider, background: true, providerTrafficClass: "record", grokContext: "record" },
    };
}

function call(
    logicalCallKey: string,
    text: string,
    counters: { invokes: number },
    provider: RouteProvider = "grok",
    routeOptions: Omit<RouteCallFixtureOptions, "providers"> = {},
): RecordSchedulerModelCallContext {
    const invoke: RouteInvoke = async options => {
        counters.invokes += 1;
        assert.match(options?.attemptId || "", /:attempt:\d+$/u, `${logicalCallKey} must receive a durable Attempt identity`);
        assert.equal(options?.transportLease?.attemptId, options?.attemptId);
        const result = { text, chainUsed: provider, modelUsed: `fake-${provider}-record` };
        if (!options?.transportLease) return result;
        return await transport.executeGranted(
            options.transportLease,
            async () => result,
            settled => settled.text === null ? "failure" : "success",
        );
    };
    return routeCall(logicalCallKey, { ...routeOptions, providers: [{ provider, invoke }] });
}

function callResult(
    logicalCallKey: string,
    result: RecordModelCallResult,
    counters: { invokes: number },
    provider: RouteProvider = "grok",
    routeOptions: Omit<RouteCallFixtureOptions, "providers"> = {},
): RecordSchedulerModelCallContext {
    const invoke: RouteInvoke = async options => {
        counters.invokes += 1;
        assert.match(options?.attemptId || "", /:attempt:\d+$/u, `${logicalCallKey} must receive a durable Attempt identity`);
        assert.equal(options?.transportLease?.attemptId, options?.attemptId);
        if (!options?.transportLease) return result;
        return await transport.executeGranted(
            options.transportLease,
            async () => result,
            settled => settled.text === null ? "failure" : "success",
        );
    };
    return routeCall(logicalCallKey, { ...routeOptions, providers: [{ provider, invoke }] });
}

function syntheticRecoveryCall(
    logicalCallKey: string,
    counters: { invokes: number },
): RecordSchedulerModelCallContext {
    return routeCall(logicalCallKey, {
        providers: [{
            provider: "codex",
            model: "fake-codex-recovery",
            invoke: async () => {
                counters.invokes += 1;
                return { text: "must-not-post-during-recovery", chainUsed: "codex", modelUsed: "fake-codex-recovery" };
            },
        }],
    });
}

const registrationA = registration(taskA);
const registrationB = registration(taskB);
const hookA = pump.register(registrationA);
const hookB = pump.register(registrationB);
const countersA = { invokes: 0 };
const countersB = { invokes: 0 };
const fairnessCountersA = { invokes: 0 };
const fairnessCountersB = { invokes: 0 };
const fairnessUnitGate = deferred<void>();
let preparedFairnessUnits = 0;
faultHandler = async event => {
    if (event.phase !== "unit-prepared" || (event.taskId !== taskA.taskId && event.taskId !== taskB.taskId)) return;
    preparedFairnessUnits += 1;
    if (preparedFairnessUnits === 4) fairnessUnitGate.resolve(undefined);
    await fairnessUnitGate.promise;
};
const [resultA, resultB, fairnessResultA, fairnessResultB] = await Promise.all([
    hookA(call("logical-a", "model-output-a", countersA)),
    hookB(call("logical-b", "model-output-b", countersB)),
    hookA(call("logical-a-fairness", "model-output-a-fairness", fairnessCountersA)),
    hookB(call("logical-b-fairness", "model-output-b-fairness", fairnessCountersB)),
]);
faultHandler = undefined;
assert.equal(resultA.text, "model-output-a");
assert.equal(resultB.text, "model-output-b");
assert.equal(fairnessResultA.text, "model-output-a-fairness");
assert.equal(fairnessResultB.text, "model-output-b-fairness");
assert.equal(countersA.invokes, 1);
assert.equal(countersB.invokes, 1);
assert.equal(acquireCount, 4, "each physical provider attempt must acquire exactly one transport admission lease");
assert.equal(fairnessCountersA.invokes, 1);
assert.equal(fairnessCountersB.invokes, 1);
const initialGrantTasks = phases.filter(event => event.phase === "grant-persisted").slice(0, 4);
assert.deepEqual(initialGrantTasks.map(event => event.taskId), [taskA.taskId, taskB.taskId, taskA.taskId, taskB.taskId], "two tasks must interleave through one fair pump");
assert.deepEqual(initialGrantTasks.map(event => event.dispatchSeq), [1, 2, 3, 4]);

const replay = await hookA(call("logical-a", "must-not-invoke", countersA));
assert.equal(replay.text, "model-output-a");
assert.equal(countersA.invokes, 1, "KnownSuccess must replay immutable JSON spool without invoking provider again");

const singleCounters = { invokes: 0 };
const singleAcquireStart = acquireCount;
const single = await hookA(call("logical-single-admission", "single-admission-output", singleCounters));
assert.equal(single.text, "single-admission-output");
assert.equal(acquireCount - singleAcquireStart, 1, "one physical model attempt must acquire exactly one provider admission lease");
assert.equal(singleCounters.invokes, 1, "one physical model attempt must invoke exactly once");
const singleReplay = await hookA(call("logical-single-admission", "must-not-invoke-single-replay", singleCounters));
assert.equal(singleReplay.text, "single-admission-output");
assert.equal(acquireCount - singleAcquireStart, 1, "KnownSuccess replay must not reacquire provider admission");
assert.equal(singleCounters.invokes, 1, "KnownSuccess replay must not invoke provider again");

const continuationCounters = { invokes: 0 };
const continuationKey = "chunks:1";
const continuationCall = call("logical-continuation-mirror", "continuation-output", continuationCounters, "grok", {
    recipe: {
        recipeVersion: 1,
        templateId: "production-pump-continuation-mirror/v1",
        range: { axis: "round", start: 1, end: 4 },
        composeOrder: 0,
        continuationKey,
    },
});
faultHandler = event => {
    if (event.phase === "unit-prepared" && event.taskId === taskA.taskId) throw new Error("inject continuation unit-prepared interruption");
};
try {
    await assert.rejects(() => hookA(continuationCall), /continuation unit-prepared interruption/u);
} finally {
    faultHandler = undefined;
}
const continuationPreAttemptLedger = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
assert.equal(continuationPreAttemptLedger.kind, "current");
if (continuationPreAttemptLedger.kind === "current") {
    const continuationUnit = continuationPreAttemptLedger.ledger.units.find(unit => unit.promptRecipe?.templateId === "production-pump-continuation-mirror/v1");
    assert.ok(continuationUnit, "unit-prepared crash window must retain the continuation recipe as a durable provider Unit");
    assert.equal(continuationUnit?.promptRecipe?.continuationKey, continuationKey);
    assert.equal(continuationUnit?.continuationKey, continuationKey, "Unit continuationKey must mirror the frozen prompt recipe before any Attempt is created");
    assert.equal(continuationPreAttemptLedger.ledger.attempts.some(attempt => attempt.unitId === continuationUnit?.unitId), false);
}
const continuationResult = await hookA(continuationCall);
assert.equal(continuationResult.text, "continuation-output");
assert.equal(continuationCounters.invokes, 1);
const continuationLedger = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
assert.equal(continuationLedger.kind, "current");
if (continuationLedger.kind === "current") {
    const continuationUnit = continuationLedger.ledger.units.find(unit => unit.promptRecipe?.templateId === "production-pump-continuation-mirror/v1");
    assert.ok(continuationUnit, "continuation recipe must persist a durable provider Unit");
    assert.equal(continuationUnit?.promptRecipe?.continuationKey, continuationKey);
    assert.equal(continuationUnit?.continuationKey, continuationKey, "Unit continuationKey must remain mirrored after Attempt completion");
}

const continuationChainCounters = { invokes: 0 };
const continuationChainKey = "chunks:dispatch-chain";
const continuationChainTemplate = "production-pump-continuation-chain/v1";
const continuationChainFirst = await hookA(call("logical-continuation-chain-0", "continuation-chain-output-0", continuationChainCounters, "grok", {
    recipe: {
        recipeVersion: 1,
        templateId: continuationChainTemplate,
        range: { axis: "round", start: 1, end: 4 },
        composeOrder: 0,
        continuationKey: continuationChainKey,
    },
}));
assert.equal(continuationChainFirst.text, "continuation-chain-output-0");
const continuationChainSecond = await hookA(call("logical-continuation-chain-1", "continuation-chain-output-1", continuationChainCounters, "grok", {
    recipe: {
        recipeVersion: 1,
        templateId: continuationChainTemplate,
        range: { axis: "round", start: 5, end: 8 },
        composeOrder: 1,
        continuationKey: continuationChainKey,
    },
}));
assert.equal(continuationChainSecond.text, "continuation-chain-output-1");
assert.equal(continuationChainCounters.invokes, 2, "a ResultReady predecessor must allow the next continuation Unit to dispatch");
const continuationChainLedger = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
assert.equal(continuationChainLedger.kind, "current");
if (continuationChainLedger.kind === "current") {
    const continuationChainUnits = continuationChainLedger.ledger.units
        .filter(unit => unit.promptRecipe?.templateId === continuationChainTemplate)
        .sort((left, right) => left.composeOrder - right.composeOrder);
    assert.equal(continuationChainUnits.length, 2);
    assert.deepEqual(continuationChainUnits[1]?.dependencies, [continuationChainUnits[0]?.unitId]);
    assert.equal(continuationChainUnits[0]?.state, "ResultReady");
    assert.equal(continuationChainUnits[1]?.state, "ResultReady");
    assert.ok(continuationChainLedger.ledger.attempts.some(attempt => attempt.unitId === continuationChainUnits[1]?.unitId && attempt.state === "KnownSuccess"));
}

const finalizationTask = await admitFixture(fixtureSource("production-pump-finalization"), "production-pump-task-owner");
const finalizationRegistration = registration(finalizationTask);
const finalizationHook = pump.register(finalizationRegistration);
const finalizationCounters = { invokes: 0 };
const finalizationModelResult = await finalizationHook(call("logical-finalization-model", "finalization-model-output", finalizationCounters));
assert.equal(finalizationModelResult.text, "finalization-model-output");
assert.equal(finalizationCounters.invokes, 1);
const finalizationLedger = await readRecordSchedulerLedgerStore(finalizationTask.taskId, { expectPublished: true });
assert.equal(finalizationLedger.kind, "current");
if (finalizationLedger.kind !== "current") throw new Error("finalization task ledger missing");
const finalizationModelUnit = finalizationLedger.ledger.units.find(unit => unit.layer === "provider-attempt");
assert.ok(finalizationModelUnit);
const finalized = await pump.finalizeLocalRecord({
    registration: finalizationRegistration,
    modelUnitIds: [finalizationModelUnit!.unitId],
    content: "# local final body\n\nThis is deliberately different from model-output-a.",
    commit: { firstPublicationToken: "production-pump-first-publication" },
});
assert.equal(finalized.kind, "verified");
assert.match(finalized.content, /local final body/u);
assert.notEqual(finalized.content, resultA.text);
assert.equal(finalized.commit.kind, "verified");

await assert.rejects(
    () => pump.finalizeLocalRecord({
        registration: finalizationRegistration,
        modelUnitIds: [finalizationModelUnit!.unitId],
        content: "# local final body\n\nChanged body must not reuse the prior local output.",
        commit: { firstPublicationToken: "production-pump-first-publication" },
    }),
    error => (error as { code?: unknown }).code === "REPAIR_REQUIRED",
);
await assert.rejects(
    () => pump.finalizeLocalRecord({
        registration: { ...finalizationRegistration, recordStoreHash: "changed-record-store-hash" },
        modelUnitIds: [finalizationModelUnit!.unitId],
        content: "# local final body\n\nThis is deliberately different from model-output-a.",
        commit: { firstPublicationToken: "production-pump-first-publication" },
    }),
    error => (error as { code?: unknown }).code === "FROZEN_SOURCE_MISMATCH",
);
await assert.rejects(
    () => pump.finalizeLocalRecord({
        registration: finalizationRegistration,
        modelUnitIds: [finalizationModelUnit!.unitId],
        content: "# local final body\n\nThis is deliberately different from model-output-a.",
        commit: { firstPublicationToken: "wrong-first-publication-token" },
    }),
    error => (error as { code?: unknown }).code === "REPAIR_REQUIRED",
);

const unboundCounters = { invokes: 0 };
const unboundAcquireStart = acquireCount;
const unboundCancelStart = cancelCount;
let injectedGrantFailure = false;
faultHandler = event => {
    if (!injectedGrantFailure && event.phase === "grant-persisted" && event.taskId === taskA.taskId) {
        injectedGrantFailure = true;
        throw new Error("inject grant-before-bind failure");
    }
};
await assert.rejects(
    () => hookA(call("logical-unbound-release", "must-not-invoke-before-bind", unboundCounters)),
    /grant-before-bind/u,
);
faultHandler = undefined;
assert.equal(unboundCounters.invokes, 0, "grant-before-bind failure must not invoke the provider");
assert.equal(acquireCount - unboundAcquireStart, 1, "unbound grant still acquires one real lease");
assert.equal(cancelCount - unboundCancelStart, 1, "unbound grant must release its unconsumed real lease");
const unboundRetry = await hookA(call("logical-unbound-release", "unbound-retry-output", unboundCounters));
assert.equal(unboundRetry.text, "unbound-retry-output");
assert.equal(unboundCounters.invokes, 1, "unbound grant can safely retry the same immutable intent");

const interruptedCounters = { invokes: 0 };
let injectedBoundFailure = false;
let interruptedInvokesBeforeRetry = -1;
faultHandler = event => {
    if (!injectedBoundFailure && event.phase === "before-invoke" && event.taskId === taskA.taskId) {
        injectedBoundFailure = true;
        interruptedInvokesBeforeRetry = interruptedCounters.invokes;
        throw new Error("inject bind-before-rpc interruption");
    }
};
const interrupted = await hookA(call("logical-bound-unknown", "pre-invoke-retry-output", interruptedCounters, "grok", { retryBudget: 1 }));
faultHandler = undefined;
assert.equal(interruptedInvokesBeforeRetry, 0, "bind-before-RPC interruption must happen before the provider invoke");
assert.equal(interrupted.text, "pre-invoke-retry-output", "the route pump must automatically consume the proven pre-invoke retry budget");
assert.equal(interruptedCounters.invokes, 1, "the automatic fenced retry must invoke the provider exactly once");
const interruptedReplay = await hookA(call("logical-bound-unknown", "must-not-invoke-pre-invoke-replay", interruptedCounters, "grok", { retryBudget: 1 }));
assert.equal(interruptedReplay.text, "pre-invoke-retry-output");
assert.equal(interruptedCounters.invokes, 1, "KnownSuccess replay after the automatic fenced retry must not invoke again");
const interruptedLedger = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
assert.equal(interruptedLedger.kind, "current");
if (interruptedLedger.kind === "current") {
    const interruptedAttempts = interruptedLedger.ledger.attempts.filter(attempt => attempt.providerEvidence?.includes("bind-before-rpc interruption")
        || attempt.unitId === interruptedLedger.ledger.attempts.find(candidate => candidate.providerEvidence?.includes("bind-before-rpc interruption"))?.unitId);
    assert.equal(interruptedAttempts.length, 2);
    assert.equal(interruptedAttempts[0]?.state, "KnownFailure");
    assert.equal(interruptedAttempts[1]?.state, "KnownSuccess");
    assert.match(interruptedAttempts[0]?.attemptId || "", /:attempt:1$/u);
    assert.match(interruptedAttempts[1]?.attemptId || "", /:attempt:2$/u);
    assert.ok((interruptedAttempts[1]?.fence.fencingToken || 0) > (interruptedAttempts[0]?.fence.fencingToken || 0));
}

const mismatchCounters = { invokes: 0 };
let injectedClaimMismatch = false;
let mismatchAttemptId = "";
const mismatchAcquireStart = acquireCount;
const mismatchCancelStart = cancelCount;
const mismatchRecoveredCancelStart = recoveredCancelCount;
const mismatchActiveLeaseStart = activePhysicalLeases;
let mismatchRepairError: unknown;
faultHandler = async event => {
    if (injectedClaimMismatch || event.phase !== "before-invoke" || event.taskId !== taskA.taskId) return;
    injectedClaimMismatch = true;
    mismatchAttemptId = event.attemptId;
    const current = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
    assert.equal(current.kind, "current");
    if (current.kind !== "current" || !current.ledger.schedulerOwner) throw new Error("missing owner while injecting claim mismatch");
    await mutateRecordSchedulerLedgerAsOwner(taskA.taskId, current.ledger.revision, current.ledger.schedulerOwner, ledger => {
        const target = ledger.attempts.find(attempt => attempt.attemptId === event.attemptId);
        if (!target) throw new Error("missing attempt while injecting claim mismatch");
        target.permitId = "tampered-permit-id";
    });
};
await assert.rejects(
    () => hookA(call("logical-claim-mismatch", "must-not-invoke-mismatch", mismatchCounters)),
    error => {
        mismatchRepairError = error;
        return (error as { code?: unknown }).code === "REPAIR_REQUIRED";
    },
);
faultHandler = undefined;
assert.equal(mismatchCounters.invokes, 0, "claim/Attempt permit mismatch must fail closed before provider invoke");
assert.equal((mismatchRepairError as { code?: unknown } | undefined)?.code, "REPAIR_REQUIRED", "caller must receive an explicit RepairRequired error");
assert.equal(acquireCount - mismatchAcquireStart, 1, "claim mismatch still consumes exactly one physical lease before the pre-invoke check");
assert.equal(cancelCount - mismatchCancelStart, 1, "claim mismatch must cancel the unconsumed physical lease");
assert.equal(recoveredCancelCount - mismatchRecoveredCancelStart, 1, "claim mismatch must fence-settle the physical lease recovery identity");
assert.equal(activePhysicalLeases, mismatchActiveLeaseStart, "claim mismatch must leave no active physical lease");
assert.equal(fakeLeaseIdentities.has(mismatchAttemptId), false, "claim mismatch must remove the provider recovery identity");
const repairLedger = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
assert.equal(repairLedger.kind, "current");
if (repairLedger.kind === "current") {
    assert.equal(repairLedger.ledger.task.state, "RepairRequired");
    assert.equal(repairLedger.ledger.attempts.find(attempt => attempt.attemptId === mismatchAttemptId)?.state, "UnknownOutcome");
}
const mismatchCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot });
assert.equal(mismatchCoordinator.kind, "current");
if (mismatchCoordinator.kind === "current") {
    assert.equal(mismatchCoordinator.snapshot.activeClaims.length, 0, "claim mismatch must remove the coordinator fairness claim after the lease is fenced-settled");
}

runtimeHolds.get(taskA.taskId)?.resolve(undefined);
const sessionFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-session-")));
const sessionTask = await admitFixture(fixtureSource("production-pump-session"), "production-pump-task-owner", sessionFixture);
const sessionRegistration = registration(sessionTask, sessionFixture);
let coordinatorPersistFaultHandler: ((event: any) => void | Promise<void>) | undefined;
const sessionOptions = {
    coordinatorOwnerId: "production-pump-session-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: sessionFixture.dataRoot },
    providerTransport: transport,
    onPhase: pumpOptions.onPhase,
    onCoordinatorPersist: async (event: any) => await coordinatorPersistFaultHandler?.(event),
};
const sessionPump = getRecordSchedulerProductionPump(sessionOptions);
const generationSession = createRecordSchedulerProductionSession(sessionRegistration, sessionOptions);
const sessionFallbackCounters = { grok: 0, agy: 0 };
const sessionFallbackCall = routeCall("logical-session-fallback", {
    requestedChain: "auto",
    providers: [
        {
            provider: "grok",
            model: "fake-grok-route",
            invoke: async options => {
                sessionFallbackCounters.grok += 1;
                const result = { text: null, error: "grok unavailable", failureClass: "Availability" as const, chainUsed: "grok" as const, modelUsed: "fake-grok-route" };
                if (!options?.transportLease) return result;
                return await transport.executeGranted(
                    options.transportLease,
                    async () => result,
                    settled => settled.text === null ? "failure" : "success",
                );
            },
        },
        {
            provider: "agy",
            model: "fake-agy-route",
            invoke: async options => {
                sessionFallbackCounters.agy += 1;
                const result = { text: "session-model-success", chainUsed: "agy" as const, modelUsed: "fake-agy-route" };
                if (!options?.transportLease) return result;
                return await transport.executeGranted(
                    options.transportLease,
                    async () => result,
                    settled => settled.text === null ? "failure" : "success",
                );
            },
        },
    ],
});
const [sessionSuccess, joinedSessionSuccess] = await Promise.all([
    generationSession.schedulerModelCall(sessionFallbackCall),
    generationSession.schedulerModelCall(sessionFallbackCall),
]);
assert.equal(sessionSuccess.text, "session-model-success");
assert.equal(joinedSessionSuccess.text, "session-model-success");
assert.deepEqual(sessionFallbackCounters, { grok: 1, agy: 1 }, "the joined route call must invoke one fallback Attempt per provider");
const sessionReplay = await generationSession.schedulerModelCall(sessionFallbackCall);
assert.equal(sessionReplay.text, "session-model-success");
assert.deepEqual(sessionFallbackCounters, { grok: 1, agy: 1 }, "route KnownSuccess replay must not invoke either provider again");
const sessionLedger = await readRecordSchedulerLedgerStore(sessionTask.taskId, { expectPublished: true });
assert.equal(sessionLedger.kind, "current");
if (sessionLedger.kind !== "current") throw new Error("session ledger missing");
const sessionModelUnitIds = sessionLedger.ledger.units
    .filter(unit => unit.layer === "provider-attempt")
    .map(unit => unit.unitId)
    .sort();
assert.equal(sessionModelUnitIds.length, 1, "Availability fallback must retain one root Unit instead of creating one Unit per provider");
const sessionFallbackUnit = sessionLedger.ledger.units.find(unit => unit.unitId === sessionModelUnitIds[0]);
assert.ok(sessionFallbackUnit);
assert.deepEqual(sessionFallbackUnit?.routePlan, ["grok", "agy"], "root Unit must persist the frozen provider route");
assert.equal(sessionFallbackUnit?.routeCursor, 1, "root Unit route cursor must advance to the successful fallback provider");
assert.deepEqual(sessionFallbackUnit?.attemptedProviders, ["grok", "agy"], "root Unit must retain both attempted providers in route order");
assert.equal(sessionFallbackUnit?.unitAttempts, 2, "root Unit counters must count both physical provider Attempts");
assert.deepEqual(sessionFallbackUnit?.providerAttemptCounts, { grok: 1, agy: 1 }, "root Unit provider counters must retain one Attempt per route entry");
const sessionFallbackAttempts = sessionLedger.ledger.attempts
    .filter(attempt => attempt.unitId === sessionFallbackUnit?.unitId)
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
assert.equal(sessionFallbackAttempts.length, 2, "one route fallback must persist two Attempts under the same root Unit");
assert.deepEqual(sessionFallbackAttempts.map(attempt => attempt.provider), ["grok", "agy"]);
assert.deepEqual(sessionFallbackAttempts.map(attempt => attempt.state), ["KnownFailure", "KnownSuccess"]);
assert.deepEqual(sessionFallbackAttempts.map(attempt => attempt.trafficClass), ["record", "agy-fallback"]);
assert.deepEqual(sessionFallbackAttempts.map(attempt => attempt.retryOrdinal), [0, 0], "each provider's first physical try must retain retry ordinal zero");
const successfulSessionUnitIds = [...new Set(sessionFallbackAttempts
    .filter(attempt => attempt.state === "KnownSuccess")
    .map(attempt => attempt.unitId))]
    .sort();
assert.deepEqual(successfulSessionUnitIds, [sessionFallbackUnit!.unitId], "only the fallback root Unit reaches KnownSuccess");
const sessionFinal = await generationSession.finalizeLocalRecord({
    content: "# session local final\n\nLocal composition is distinct from both model calls.",
    commit: { firstPublicationToken: "production-pump-first-publication" },
});
assert.equal(sessionFinal.kind, "verified", "KnownFailure followed by provider fallback must finalize with the successful Unit only");
const finalizedSessionLedger = await readRecordSchedulerLedgerStore(sessionTask.taskId, { expectPublished: true });
assert.equal(finalizedSessionLedger.kind, "current");
if (finalizedSessionLedger.kind === "current") {
    assert.deepEqual(
        finalizedSessionLedger.ledger.units.find(unit => unit.layer === "local-finalize")?.dependencies,
        successfulSessionUnitIds,
        "session finalize must depend on the durable fallback root Unit, not a provider-specific sibling Unit",
    );
}

const congestionFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-congestion-")));
const congestionTask = await admitFixture(fixtureSource("production-pump-congestion"), "production-pump-task-owner", congestionFixture);
const congestionRegistration = registration(congestionTask, congestionFixture);
let congestionWaitingEvidence: {
    unitId: string;
    state: string;
    routeCursor: number | undefined;
    retryBudget: number;
    nextEligibleAt: string | undefined;
    attemptFence: unknown;
} | undefined;
const congestionPump = new RecordSchedulerProductionPump({
    coordinatorOwnerId: "production-pump-congestion-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: congestionFixture.dataRoot },
    providerTransport: transport,
    onPhase: async event => {
        if (event.phase !== "known-failure" || event.taskId !== congestionTask.taskId) return;
        const stored = await readRecordSchedulerLedgerStore(congestionTask.taskId, { expectPublished: true });
        if (stored.kind !== "current") throw new Error("congestion fixture ledger missing during WaitingRetry evidence capture");
        const unit = stored.ledger.units.find(candidate => candidate.unitId === event.unitId);
        const attempt = stored.ledger.attempts.find(candidate => candidate.attemptId === event.attemptId);
        if (!unit || !attempt) throw new Error("congestion fixture missing Unit or Attempt during WaitingRetry evidence capture");
        congestionWaitingEvidence = {
            unitId: unit.unitId,
            state: unit.state,
            routeCursor: unit.routeCursor,
            retryBudget: unit.retryBudget,
            nextEligibleAt: unit.nextEligibleAt,
            attemptFence: attempt.fence,
        };
    },
});
const congestionCounters = { invokes: 0 };
const congestionResult = await congestionPump.register(congestionRegistration)(routeCall("logical-congestion-retry", {
    retryBudget: 1,
    providers: [{
        provider: "grok",
        model: "fake-grok-congestion",
        invoke: async options => {
            congestionCounters.invokes += 1;
            const result = congestionCounters.invokes === 1
                ? { text: null, error: "provider congested", failureClass: "Congestion" as const, chainUsed: "grok" as const, modelUsed: "fake-grok-congestion" }
                : { text: "congestion-retry-success", chainUsed: "grok" as const, modelUsed: "fake-grok-congestion" };
            if (!options?.transportLease) return result;
            return await transport.executeGranted(
                options.transportLease,
                async () => result,
                settled => settled.text === null ? "failure" : "success",
            );
        },
    }],
}));
assert.equal(congestionResult.text, "congestion-retry-success");
assert.equal(congestionCounters.invokes, 2, "Congestion must retry the same provider exactly once within its retry budget");
assert.equal(congestionWaitingEvidence?.state, "WaitingRetry", "first congestion failure must persist WaitingRetry before the second Attempt");
assert.equal(congestionWaitingEvidence?.routeCursor, 0, "same-provider retry must keep the route cursor on grok");
assert.equal(congestionWaitingEvidence?.retryBudget, 0, "same-provider retry must consume the one available retry budget");
assert.ok(congestionWaitingEvidence?.nextEligibleAt, "WaitingRetry must persist a retry eligibility fence");
const congestionLedger = await readRecordSchedulerLedgerStore(congestionTask.taskId, { expectPublished: true });
assert.equal(congestionLedger.kind, "current");
if (congestionLedger.kind !== "current") throw new Error("congestion ledger missing");
const congestionUnit = congestionLedger.ledger.units.find(unit => unit.layer === "provider-attempt");
assert.ok(congestionUnit);
assert.equal(congestionUnit?.unitId, congestionWaitingEvidence?.unitId, "Congestion retry must retain the original root Unit");
assert.deepEqual(congestionUnit?.routePlan, ["grok"]);
assert.equal(congestionUnit?.routeCursor, 0);
assert.deepEqual(congestionUnit?.attemptedProviders, ["grok"]);
assert.equal(congestionUnit?.unitAttempts, 2);
assert.deepEqual(congestionUnit?.providerAttemptCounts, { grok: 2 });
const congestionAttempts = congestionLedger.ledger.attempts
    .filter(attempt => attempt.unitId === congestionUnit?.unitId)
    .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
assert.deepEqual(congestionAttempts.map(attempt => attempt.state), ["KnownFailure", "KnownSuccess"]);
assert.deepEqual(congestionAttempts.map(attempt => attempt.provider), ["grok", "grok"]);
assert.deepEqual(congestionAttempts.map(attempt => attempt.retryOrdinal), [0, 1], "same-provider retries must advance retryOrdinal without changing Unit");
assert.notDeepEqual(congestionAttempts[0]?.fence, congestionAttempts[1]?.fence, "WaitingRetry must rotate the scheduler fence before dispatching the next Attempt");
assert.deepEqual(congestionAttempts[0]?.fence, congestionWaitingEvidence?.attemptFence, "WaitingRetry evidence must come from the first failed Attempt fence");
await releaseRuntimeHoldAndWait(congestionFixture, congestionTask.taskId, "congestion fixture");
await congestionPump.close({ timeoutMs: 5_000 });

const splitFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-split-")));
const splitTask = await admitFixture(fixtureSource("production-pump-quality-split"), "production-pump-task-owner", splitFixture);
const splitRegistration = registration(splitTask, splitFixture);
const splitRootPrompt = "quality split root 1-4";
const splitRecipe: RecordSchedulerModelCallContext["recipe"] = {
    recipeVersion: 1,
    templateId: "production-pump-quality-split/v1",
    range: { axis: "round", start: 1, end: 4 },
    composeOrder: 0,
};
const splitPrompt = (range: RecordSchedulerModelCallContext["recipe"]["range"]) => `quality split child ${range.start}-${range.end}`;
function qualitySplitCall(invokePrompt: RouteInvokePrompt): RecordSchedulerModelCallContext {
    return routeCall("logical-quality-split", {
        prompt: splitRootPrompt,
        recipe: splitRecipe,
        splitPrompt,
        providers: [{
            provider: "grok",
            model: "fake-grok-quality-split",
            invoke: async options => await invokePrompt(splitRootPrompt, options),
            invokePrompt,
        }],
    });
}
const splitProvenanceFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-split-provenance-")));
const splitProvenanceTask = await admitFixture(fixtureSource("production-pump-quality-split-provenance"), "production-pump-task-owner", splitProvenanceFixture);
const splitProvenanceRegistration = registration(splitProvenanceTask, splitProvenanceFixture);
const splitProvenanceCall = qualitySplitCall(async (_prompt, options) => {
    const result = { text: null, error: "root output needs splitting", failureClass: "Quality" as const, chainUsed: "grok" as const, modelUsed: "fake-grok-quality-split" };
    if (!options?.transportLease) return result;
    return await transport.executeGranted(
        options.transportLease,
        async () => result,
        () => "failure",
    );
});
let splitProvenanceInjected = false;
let splitProvenancePump!: InstanceType<typeof RecordSchedulerProductionPump>;
splitProvenancePump = new RecordSchedulerProductionPump({
    coordinatorOwnerId: "production-pump-quality-split-provenance-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: splitProvenanceFixture.dataRoot },
    providerTransport: transport,
    onPhase: async event => {
        if (splitProvenanceInjected || event.phase !== "unit-prepared" || event.taskId !== splitProvenanceTask.taskId) return;
        splitProvenanceInjected = true;
        const current = await readRecordSchedulerLedgerStore(splitProvenanceTask.taskId, { expectPublished: true });
        assert.equal(current.kind, "current");
        if (current.kind !== "current" || !current.ledger.schedulerOwner) throw new Error("split provenance fixture missing scheduler owner");
        await mutateRecordSchedulerLedgerAsOwner(splitProvenanceTask.taskId, current.ledger.revision, current.ledger.schedulerOwner, ledger => {
            const parent = ledger.units.find(unit => unit.unitId === event.unitId);
            if (!parent) throw new Error("split provenance fixture missing root Unit");
            const childRange = { axis: "round" as const, start: 1, end: 2 };
            const childRecipe = { ...structuredClone(splitRecipe), range: childRange };
            const childUnitId = `${parent.unitId}.split-1`;
            const childDescriptor = {
                unitId: childUnitId,
                prompt: splitPrompt(childRange),
                recipe: childRecipe,
                parentUnitId: parent.unitId,
                splitDepth: 1,
                dependencies: [...parent.dependencies],
                promptDependencyIds: [],
            };
            const child = structuredClone(parent);
            child.unitId = childUnitId;
            child.state = "Queued";
            child.parentUnitId = parent.unitId;
            child.splitDepth = 1;
            child.dependencies = [...parent.dependencies];
            child.inputHash = (splitProvenancePump as any).modelUnitInputHash(
                splitProvenanceRegistration,
                splitProvenanceCall,
                childDescriptor,
                splitProvenanceRegistration.sourceSnapshotId,
            );
            child.estimatedCost = Math.max(0.5, parent.estimatedCost / 2);
            child.routeCursor = 0;
            child.attemptedProviders = [];
            child.unitAttempts = 0;
            child.providerAttemptCounts = {};
            child.promptRecipe = structuredClone(splitRecipe);
            delete child.childUnitIds;
            delete child.composeProvenance;
            delete child.nextEligibleAt;
            delete child.failureClass;
            delete child.resultRef;
            delete child.coveredRevision;
            delete child.commitId;
            parent.childUnitIds = [childUnitId];
            ledger.units.push(child);
            ledger.task.units.materialized = ledger.units.length;
            ledger.task.units.eligible = ledger.units.filter(unit => unit.state === "Queued").length;
            ledger.task.units.running = ledger.units.filter(unit => unit.state === "Running" || unit.state === "Committing").length;
            ledger.task.units.done = ledger.units.filter(unit => ["Succeeded", "FailedFinal", "Cancelled", "Discarded", "Superseded"].includes(unit.state)).length;
            ledger.task.units.failed = ledger.units.filter(unit => unit.state === "FailedFinal").length;
        });
    },
});
try {
    await assert.rejects(
        () => splitProvenancePump.register(splitProvenanceRegistration)(splitProvenanceCall),
        error => (error as { code?: unknown }).code === "REPAIR_REQUIRED"
            && /split child .* parent provenance/u.test(error instanceof Error ? error.message : String(error)),
        "a pre-existing split child with a forged prompt recipe must fail closed",
    );
    assert.equal(splitProvenanceInjected, true, "the split provenance fixture must inject its durable child before root failure handling");
} finally {
    await releaseRuntimeHoldAndWait(splitProvenanceFixture, splitProvenanceTask.taskId, "quality split provenance fixture");
    await splitProvenancePump.close({ timeoutMs: 5_000 });
}
const splitCounters = { invokes: 0 };
const splitPrompts: string[] = [];
const splitInitialInvoke: RouteInvokePrompt = async (prompt, options) => {
    splitCounters.invokes += 1;
    splitPrompts.push(prompt);
    const result = prompt === splitRootPrompt
        ? { text: null, error: "root output needs splitting", failureClass: "Quality" as const, chainUsed: "grok" as const, modelUsed: "fake-grok-quality-split" }
        : { text: `composed ${prompt}`, chainUsed: "grok" as const, modelUsed: "fake-grok-quality-split" };
    if (!options?.transportLease) return result;
    return await transport.executeGranted(
        options.transportLease,
        async () => result,
        settled => settled.text === null ? "failure" : "success",
    );
};
const splitPumpOptions = {
    coordinatorOwnerId: "production-pump-quality-split-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: splitFixture.dataRoot },
    providerTransport: transport,
};
const splitPump = new RecordSchedulerProductionPump(splitPumpOptions);
const splitInitial = await splitPump.register(splitRegistration)(qualitySplitCall(splitInitialInvoke));
assert.equal(splitInitial.text, "composed quality split child 1-2\n\ncomposed quality split child 3-4", "Quality split must return the durable child composition");
assert.deepEqual(splitPrompts, [splitRootPrompt, "quality split child 1-2", "quality split child 3-4"]);
assert.equal(splitCounters.invokes, 3, "Quality split must invoke the failed root and both split children once");
const splitLedgerBeforeReplay = await readRecordSchedulerLedgerStore(splitTask.taskId, { expectPublished: true });
assert.equal(splitLedgerBeforeReplay.kind, "current");
if (splitLedgerBeforeReplay.kind !== "current") throw new Error("quality split ledger missing");
const splitParent = splitLedgerBeforeReplay.ledger.units.find(unit => unit.layer === "provider-attempt" && !unit.parentUnitId);
assert.ok(splitParent);
assert.equal(splitParent?.state, "Superseded", "Quality failure must supersede the root Unit once split children exist");
assert.equal(splitParent?.splitDepth, 0);
assert.equal(splitParent?.failureClass, "Quality");
assert.equal(splitParent?.childUnitIds?.length, 2, "Quality split must persist exactly two first-depth children");
const splitChildUnitIds = splitParent?.childUnitIds || [];
const splitChildren = splitChildUnitIds.map(unitId => splitLedgerBeforeReplay.ledger.units.find(unit => unit.unitId === unitId));
assert.deepEqual(splitChildren.map(unit => unit?.splitDepth), [1, 1]);
assert.deepEqual(splitChildren.map(unit => unit?.parentUnitId), [splitParent!.unitId, splitParent!.unitId]);
assert.deepEqual(splitChildren.map(unit => unit?.state), ["ResultReady", "ResultReady"]);
assert.deepEqual(
    splitLedgerBeforeReplay.ledger.attempts
        .filter(attempt => splitChildUnitIds.includes(attempt.unitId))
        .map(attempt => attempt.state)
        .sort(),
    ["KnownSuccess", "KnownSuccess"],
    "both split children must persist KnownSuccess Attempts",
);
assert.deepEqual(splitParent?.composeProvenance?.childUnitIds, splitChildUnitIds, "parent compose provenance must close over its two persisted child Units");
assert.ok(splitParent?.composeProvenance?.outputHash, "parent compose provenance must seal the composed output hash");
const splitProviderAttemptCount = splitLedgerBeforeReplay.ledger.attempts.filter(attempt => attempt.unitId === splitParent?.unitId || splitChildUnitIds.includes(attempt.unitId)).length;
const rebuiltSplitPump = new RecordSchedulerProductionPump({
    ...splitPumpOptions,
    coordinatorOwnerId: "production-pump-quality-split-rebuilt-coordinator",
});
const splitReplayCounters = { invokes: 0 };
const splitReplay = await rebuiltSplitPump.register(splitRegistration)(qualitySplitCall(async () => {
    splitReplayCounters.invokes += 1;
    return { text: "must-not-invoke-split-replay", chainUsed: "grok", modelUsed: "fake-grok-quality-split" };
}));
assert.equal(splitReplay.text, splitInitial.text, "a reconstructed pump must replay the composed text from the durable child outputs");
assert.equal(splitReplayCounters.invokes, 0, "composed replay must not invoke any provider after pump reconstruction");
const splitLedgerAfterReplay = await readRecordSchedulerLedgerStore(splitTask.taskId, { expectPublished: true });
assert.equal(splitLedgerAfterReplay.kind, "current");
if (splitLedgerAfterReplay.kind !== "current") throw new Error("quality split replay ledger missing");
assert.equal(
    splitLedgerAfterReplay.ledger.attempts.filter(attempt => attempt.unitId === splitParent?.unitId || splitChildUnitIds.includes(attempt.unitId)).length,
    splitProviderAttemptCount,
    "composed replay must not add provider Attempts after rebuilding the pump",
);
const persistedSplitSession = createRecordSchedulerProductionSession(splitRegistration, {
    ...splitPumpOptions,
    coordinatorOwnerId: "production-pump-quality-split-finalize-coordinator",
});
const splitFinal = await persistedSplitSession.finalizeLocalRecord({
    content: "# split final\n\nA new session finalizes from durable successful child leaves.",
    commit: { firstPublicationToken: "production-pump-first-publication" },
});
assert.equal(splitFinal.kind, "verified");
const splitFinalLedger = await readRecordSchedulerLedgerStore(splitTask.taskId, { expectPublished: true });
assert.equal(splitFinalLedger.kind, "current");
if (splitFinalLedger.kind !== "current") throw new Error("quality split final ledger missing");
const splitLocalFinalize = splitFinalLedger.ledger.units.find(unit => unit.layer === "local-finalize");
assert.deepEqual(splitLocalFinalize?.dependencies, splitChildUnitIds, "a fresh session must derive local-finalize dependencies from persisted successful child leaves");
assert.equal(splitLocalFinalize?.dependencies.includes(splitParent!.unitId), false, "a split parent must never be used as a local-finalize dependency");
await releaseRuntimeHoldAndWait(splitFixture, splitTask.taskId, "quality split fixture");
await splitPump.close({ timeoutMs: 5_000 });
await rebuiltSplitPump.close({ timeoutMs: 5_000 });

const failureHook = sessionPump.register(sessionRegistration);
const unsplittableFailureRecipe: RecordSchedulerModelCallContext["recipe"] = {
    recipeVersion: 1,
    templateId: "production-pump-known-failure/v1",
    range: { axis: "round", start: 1, end: 1 },
    composeOrder: 0,
};
const explicitFailureCounters = { invokes: 0 };
const explicitFailure = await failureHook(callResult("logical-known-quality-failure", {
    text: null,
    error: "provider returned an unusable answer",
    failureClass: "Quality",
}, explicitFailureCounters, "grok", { recipe: unsplittableFailureRecipe }));
assert.equal(explicitFailure.text, null);
const fallbackFailureCounters = { invokes: 0 };
const fallbackFailure = await failureHook(callResult("logical-known-fallback-failure", {
    text: null,
    error: "provider ordinary error",
}, fallbackFailureCounters, "grok", { recipe: unsplittableFailureRecipe }));
assert.equal(fallbackFailure.text, null);
const failureLedger = await readRecordSchedulerLedgerStore(sessionTask.taskId, { expectPublished: true });
assert.equal(failureLedger.kind, "current");
if (failureLedger.kind === "current") {
    assert.equal(failureLedger.ledger.attempts.find(attempt => attempt.model === "fake-grok-record" && attempt.errorClass === "Quality")?.state, "KnownFailure");
    assert.equal(failureLedger.ledger.attempts.some(attempt => attempt.state === "KnownFailure" && attempt.errorClass === "UnknownOutcome"), false, "ordinary KnownFailure must never be labeled UnknownOutcome");
}

let injectedCoordinatorPersistFailure = false;
coordinatorPersistFaultHandler = async event => {
    if (!injectedCoordinatorPersistFailure && event.phase === "after-write" && event.snapshot.activeClaims.length > 0) {
        injectedCoordinatorPersistFailure = true;
        throw new Error("inject coordinator persist failure after grant write");
    }
};
const persistFailureHook = sessionPump.register(sessionRegistration);
const persistFailureCounters = { invokes: 0 };
const persistFailureAcquireStart = acquireCount;
const persistFailureCancelStart = cancelCount;
const persistFailureRecoveredCancelStart = recoveredCancelCount;
const persistFailureActiveLeaseStart = activePhysicalLeases;
await assert.rejects(
    () => persistFailureHook(call("logical-persist-failure", "must-not-invoke-after-grant-persist-failure", persistFailureCounters)),
    /persist failure/u,
);
coordinatorPersistFaultHandler = undefined;
await sleep(80);
assert.equal(persistFailureCounters.invokes, 0, "grant snapshot persistence failure must not invoke provider RPC");
assert.equal(acquireCount - persistFailureAcquireStart, 1, "grant snapshot persistence failure must not acquire a second lease");
assert.equal(cancelCount - persistFailureCancelStart, 1, "grant snapshot persistence failure must release its unconsumed physical lease");
assert.equal(recoveredCancelCount - persistFailureRecoveredCancelStart, 1, "grant snapshot persistence failure must fenced-verify recovered lease settlement");
assert.equal(activePhysicalLeases, persistFailureActiveLeaseStart, "grant snapshot persistence failure must leave no physical provider lease orphan");
const persistFailureLedger = await readRecordSchedulerLedgerStore(sessionTask.taskId, { expectPublished: true });
assert.equal(persistFailureLedger.kind, "current");
if (persistFailureLedger.kind === "current") {
    assert.equal(persistFailureLedger.ledger.task.state, "RepairRequired", "a possibly persisted active claim must fail closed instead of retrying");
}

sessionFixture.runtimeHolds.get(sessionTask.taskId)?.resolve(undefined);
const zeroFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-zero-")));
const zeroTask = await admitFixture(fixtureSource("production-pump-zero-model"), "production-pump-task-owner", zeroFixture);
const zeroRegistration = registration(zeroTask, zeroFixture);
const zeroSessionOptions = {
    coordinatorOwnerId: "production-pump-zero-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: zeroFixture.dataRoot },
    providerTransport: transport,
};
const zeroSession = createRecordSchedulerProductionSession(zeroRegistration, zeroSessionOptions);
const zeroFinal = await zeroSession.finalizeLocalRecord({
    content: "# zero model final\n\nUp-to-date records still commit a persistent local final Unit.",
    commit: { firstPublicationToken: "production-pump-first-publication" },
});
assert.equal(zeroFinal.kind, "verified");
const zeroLedger = await readRecordSchedulerLedgerStore(zeroTask.taskId, { expectPublished: true });
assert.equal(zeroLedger.kind, "current");
if (zeroLedger.kind === "current") {
    assert.deepEqual(zeroLedger.ledger.units.find(unit => unit.layer === "local-finalize")?.dependencies, [], "zero-model session must persist a local-finalize Unit with no dependencies");
}

zeroFixture.runtimeHolds.get(zeroTask.taskId)?.resolve(undefined);
const replayFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-replay-")));
const replayTask = await admitFixture(fixtureSource("production-pump-session-replay"), "production-pump-task-owner", replayFixture);
const replayRegistration = registration(replayTask, replayFixture);
const replaySessionOptions = {
    coordinatorOwnerId: "production-pump-replay-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: replayFixture.dataRoot },
    providerTransport: transport,
};
const initialReplaySession = createRecordSchedulerProductionSession(replayRegistration, replaySessionOptions);
const initialReplayCounters = { invokes: 0 };
const initialReplay = await initialReplaySession.schedulerModelCall(call("logical-session-replay", "session-replay-model-output", initialReplayCounters));
assert.equal(initialReplay.text, "session-replay-model-output");
const restartedReplaySession = createRecordSchedulerProductionSession(replayRegistration, replaySessionOptions);
const restartedReplayCounters = { invokes: 0 };
const restartedReplay = await restartedReplaySession.schedulerModelCall(call("logical-session-replay", "must-not-invoke-restarted-session", restartedReplayCounters));
assert.equal(restartedReplay.text, "session-replay-model-output");
assert.equal(initialReplayCounters.invokes, 1);
assert.equal(restartedReplayCounters.invokes, 0, "restarted session must replay immutable KnownSuccess without a second provider invoke");
const restartedReplayFinal = await restartedReplaySession.finalizeLocalRecord({
    content: "# replay session final\n\nA restarted session finalizes from its replayed model Unit.",
    commit: { firstPublicationToken: "production-pump-first-publication" },
});
assert.equal(restartedReplayFinal.kind, "verified", "KnownSuccess replay must be recollected by a fresh session before finalize");

replayFixture.runtimeHolds.get(replayTask.taskId)?.resolve(undefined);
const mismatchFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-store-mismatch-")));
const mismatchTask = await admitFixture(fixtureSource("production-pump-store-mismatch"), "production-pump-task-owner", mismatchFixture);
const matchedRegistration = registration(mismatchTask, mismatchFixture);
const mismatchedRegistration = { ...matchedRegistration, recordStoreHash: "wrong-workspace-hash" };
const mismatchPump = getRecordSchedulerProductionPump({
    coordinatorOwnerId: "production-pump-store-mismatch-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: mismatchFixture.dataRoot },
    providerTransport: transport,
});
const storeHashMismatchCounters = { invokes: 0 };
let storeHashMismatchCommitHookCalls = 0;
await assert.rejects(
    () => mismatchPump.submit(mismatchedRegistration, call("logical-store-mismatch", "must-not-invoke-store-mismatch", storeHashMismatchCounters)),
    error => (error as { code?: unknown }).code === "FROZEN_SOURCE_MISMATCH",
);
await assert.rejects(
    () => mismatchPump.finalizeLocalRecord({
        registration: mismatchedRegistration,
        modelUnitIds: [],
        content: "# mismatch must not write",
        commit: {
            firstPublicationToken: "production-pump-first-publication",
            hooks: { onFaultPoint: async () => { storeHashMismatchCommitHookCalls += 1; } },
        },
    }),
    error => (error as { code?: unknown }).code === "FROZEN_SOURCE_MISMATCH",
);
assert.equal(storeHashMismatchCounters.invokes, 0, "workspace-hash mismatch must fail before provider invoke");
assert.equal(storeHashMismatchCommitHookCalls, 0, "workspace-hash mismatch must fail before record commit writes");
const mismatchLedger = await readRecordSchedulerLedgerStore(mismatchTask.taskId, { expectPublished: true });
assert.equal(mismatchLedger.kind, "current");
if (mismatchLedger.kind === "current") {
    assert.equal(mismatchLedger.ledger.units.length, 0);
    assert.equal(mismatchLedger.ledger.attempts.length, 0);
    assert.equal(mismatchLedger.ledger.commits.length, 0);
}

mismatchFixture.runtimeHolds.get(mismatchTask.taskId)?.resolve(undefined);

const dependencyRetryFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-dependency-retry-")));
const dependencyRetryTask = await admitFixture(fixtureSource("production-pump-dependency-retry"), "production-pump-task-owner", dependencyRetryFixture);
const dependencyRetryRegistration = registration(dependencyRetryTask, dependencyRetryFixture);
let injectDependencyCollectionFailure = true;
let dependencyRetryProtocolWrites = 0;
const dependencyRetrySession = createRecordSchedulerProductionSession(dependencyRetryRegistration, {
    coordinatorOwnerId: "production-pump-dependency-retry-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: dependencyRetryFixture.dataRoot },
    providerTransport: transport,
    onPhase: async event => {
        if (event.phase === "local-finalize-verified" && injectDependencyCollectionFailure) {
            injectDependencyCollectionFailure = false;
            throw new Error("inject dependency collection failure after verified commit");
        }
    },
});
const dependencyRetryProviderCounters = { invokes: 0 };
const dependencyRetryModel = await dependencyRetrySession.schedulerModelCall(call("logical-dependency-retry", "dependency-retry-model-output", dependencyRetryProviderCounters));
assert.equal(dependencyRetryModel.text, "dependency-retry-model-output");
const dependencyRetryCommit = {
    firstPublicationToken: "production-pump-first-publication",
    hooks: {
        onFaultPoint: async () => { dependencyRetryProtocolWrites += 1; },
    },
};
await assert.rejects(
    () => dependencyRetrySession.finalizeLocalRecord({
        content: "# dependency retry final\n\nThe commit is durable before dependency collection fails.",
        commit: dependencyRetryCommit,
    }),
    /dependency collection failure/u,
);
const dependencyRetryLedgerBefore = await readRecordSchedulerLedgerStore(dependencyRetryTask.taskId, { expectPublished: true });
assert.equal(dependencyRetryLedgerBefore.kind, "current");
if (dependencyRetryLedgerBefore.kind !== "current") throw new Error("dependency retry ledger missing after injected collection failure");
const dependencyRetryLocalBefore = dependencyRetryLedgerBefore.ledger.units.find(unit => unit.layer === "local-finalize");
const dependencyRetryModelBefore = dependencyRetryLedgerBefore.ledger.units.find(unit => unit.layer === "provider-attempt");
assert.equal(dependencyRetryLocalBefore?.state, "Succeeded", "Verified protocol projection must survive the injected post-commit failure");
assert.equal(dependencyRetryModelBefore?.state, "ResultReady", "failed dependency collection must leave model Unit ready for the retry");
const dependencyRetryWritesAfterFirstFinalize = dependencyRetryProtocolWrites;
const dependencyRetryFinal = await dependencyRetrySession.finalizeLocalRecord({
    content: "# dependency retry final\n\nThe commit is durable before dependency collection fails.",
    commit: dependencyRetryCommit,
});
assert.equal(dependencyRetryFinal.kind, "verified");
assert.equal(dependencyRetryProviderCounters.invokes, 1, "retry must replay the model Unit without a second provider invoke");
assert.equal(dependencyRetryProtocolWrites, dependencyRetryWritesAfterFirstFinalize, "Verified retry must not rewrite the Record body or protocol ledger");
const dependencyRetryLedgerAfter = await readRecordSchedulerLedgerStore(dependencyRetryTask.taskId, { expectPublished: true });
assert.equal(dependencyRetryLedgerAfter.kind, "current");
if (dependencyRetryLedgerAfter.kind === "current") {
    assert.equal(dependencyRetryLedgerAfter.ledger.units.find(unit => unit.layer === "local-finalize")?.state, "Succeeded");
    assert.equal(dependencyRetryLedgerAfter.ledger.units.find(unit => unit.layer === "provider-attempt")?.state, "Succeeded", "retry must complete model dependency collection");
}

dependencyRetryFixture.runtimeHolds.get(dependencyRetryTask.taskId)?.resolve(undefined);

const zeroDependencyRetryFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-zero-dependency-retry-")));
const zeroDependencyRetryTask = await admitFixture(fixtureSource("production-pump-zero-dependency-retry"), "production-pump-task-owner", zeroDependencyRetryFixture);
const zeroDependencyRetryRegistration = registration(zeroDependencyRetryTask, zeroDependencyRetryFixture);
let injectZeroDependencyCollectionFailure = true;
let zeroDependencyRetryProtocolWrites = 0;
const zeroDependencyRetrySession = createRecordSchedulerProductionSession(zeroDependencyRetryRegistration, {
    coordinatorOwnerId: "production-pump-zero-dependency-retry-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: zeroDependencyRetryFixture.dataRoot },
    providerTransport: transport,
    onPhase: async event => {
        if (event.phase === "local-finalize-verified" && injectZeroDependencyCollectionFailure) {
            injectZeroDependencyCollectionFailure = false;
            throw new Error("inject zero dependency collection failure after verified commit");
        }
    },
});
const zeroDependencyRetryCommit = {
    firstPublicationToken: "production-pump-first-publication",
    hooks: {
        onFaultPoint: async () => { zeroDependencyRetryProtocolWrites += 1; },
    },
};
await assert.rejects(
    () => zeroDependencyRetrySession.finalizeLocalRecord({
        content: "# zero dependency retry final\n\nNo model Unit is required for this durable local finalize.",
        commit: zeroDependencyRetryCommit,
    }),
    /zero dependency collection failure/u,
);
const zeroDependencyRetryWritesAfterFirstFinalize = zeroDependencyRetryProtocolWrites;
const zeroDependencyRetryFinal = await zeroDependencyRetrySession.finalizeLocalRecord({
    content: "# zero dependency retry final\n\nNo model Unit is required for this durable local finalize.",
    commit: zeroDependencyRetryCommit,
});
assert.equal(zeroDependencyRetryFinal.kind, "verified");
assert.equal(zeroDependencyRetryProtocolWrites, zeroDependencyRetryWritesAfterFirstFinalize, "zero-model retry must not rewrite the durable body");
const zeroDependencyRetryLedger = await readRecordSchedulerLedgerStore(zeroDependencyRetryTask.taskId, { expectPublished: true });
assert.equal(zeroDependencyRetryLedger.kind, "current");
if (zeroDependencyRetryLedger.kind === "current") {
    const localUnit = zeroDependencyRetryLedger.ledger.units.find(unit => unit.layer === "local-finalize");
    assert.deepEqual(localUnit?.dependencies, []);
    assert.equal(localUnit?.state, "Succeeded");
}

await releaseRuntimeHoldAndWait(mainFixture, taskA.taskId, "primary task A");
await releaseRuntimeHoldAndWait(mainFixture, taskB.taskId, "primary task B");
await releaseRuntimeHoldAndWait(mainFixture, finalizationTask.taskId, "finalization task");
await releaseRuntimeHoldAndWait(sessionFixture, sessionTask.taskId, "session fixture task");
await releaseRuntimeHoldAndWait(zeroFixture, zeroTask.taskId, "zero-model fixture task");
await releaseRuntimeHoldAndWait(replayFixture, replayTask.taskId, "replay fixture task");
await releaseRuntimeHoldAndWait(mismatchFixture, mismatchTask.taskId, "store-mismatch fixture task");
await releaseRuntimeHoldAndWait(dependencyRetryFixture, dependencyRetryTask.taskId, "dependency retry fixture task");
await releaseRuntimeHoldAndWait(zeroDependencyRetryFixture, zeroDependencyRetryTask.taskId, "zero-dependency retry fixture task");
const preConcurrentQueue = backgroundTaskDiagnostics();
assert.deepEqual(
    preConcurrentQueue.queue,
    { active: 0, pending: 0 },
    `concurrent pump case requires every earlier background task to settle naturally: ${JSON.stringify(preConcurrentQueue)}`,
);
assert.deepEqual(
    preConcurrentQueue.lanes.recordUpdate,
    { active: 0, pending: 0 },
    `concurrent pump case must not inherit an occupied record-update lane: ${JSON.stringify(preConcurrentQueue)}`,
);
assert.deepEqual(
    preConcurrentQueue.lanes.recordBatchUpdate,
    { active: 0, pending: 0 },
    `concurrent pump case must begin with an empty record-batch-update lane: ${JSON.stringify(preConcurrentQueue)}`,
);

const handoffDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-handoff-"));
const blockedGrokFixture = createPumpFixture(handoffDataRoot, "handoff-grok");
const availableAgyFixture = createPumpFixture(handoffDataRoot, "handoff-agy-auto");
const overflowAgyFixture = createPumpFixture(handoffDataRoot, "handoff-grok-to-agy-overflow");
const syntheticFallbackFixture = createPumpFixture(handoffDataRoot, "handoff-antigravity-to-codex");
const blockedGrokTask = await admitFixture(fixtureSource("production-pump-handoff-grok"), "handoff-owner-grok", blockedGrokFixture);
const availableAgyTask = await admitFixture(fixtureSource("production-pump-handoff-agy"), "handoff-owner-agy", availableAgyFixture);
const overflowAgyTask = await admitFixture(fixtureSource("production-pump-handoff-grok-to-agy"), "handoff-owner-overflow", overflowAgyFixture);
const syntheticFallbackTask = await admitFixture(fixtureSource("production-pump-handoff-antigravity-to-codex"), "handoff-owner-synthetic-fallback", syntheticFallbackFixture);
const handoffTryEvents: Array<{ provider: "grok" | "agy"; trafficClass: ProviderTrafficClass; attemptId: string }> = [];
const handoffRecoveredCancellations: string[] = [];
const handoffLeaseIdentities = new Map<string, {
    provider: "grok" | "agy";
    trafficClass: ProviderTrafficClass;
    attemptId: string;
    leaseId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAt: number;
    expiresAt: number;
}>();
const handoffAdmission = {
    async tryAcquire(provider: "grok" | "agy", trafficClass: ProviderTrafficClass, invocation: { attemptId: string }) {
        handoffTryEvents.push({ provider, trafficClass, attemptId: invocation.attemptId });
        if (provider === "grok") return null;
        const identity = {
            provider,
            trafficClass,
            attemptId: invocation.attemptId,
            leaseId: `handoff-lease-${invocation.attemptId}`,
            ownerEpoch: 1,
            capacityGeneration: 1,
            acquiredAt: Date.now(),
            expiresAt: Date.now() + 120_000,
        } as const;
        handoffLeaseIdentities.set(invocation.attemptId, identity);
        let completed = false;
        return {
            leaseId: identity.leaseId,
            leaseIdentity: identity,
            async assertCurrent() {},
            async complete() {
                if (!completed) {
                    completed = true;
                    handoffLeaseIdentities.delete(invocation.attemptId);
                }
                return true;
            },
        };
    },
    async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
        const identity = handoffLeaseIdentities.get(attemptId);
        return identity?.provider === provider ? { kind: "active" as const, identity } : { kind: "absent" as const };
    },
    async settleRecoveredLease(identity: { attemptId: string }) {
        const existed = handoffLeaseIdentities.delete(identity.attemptId);
        return { kind: existed ? "settled" as const : "already-settled" as const };
    },
    async cancelRecoveredLease(identity: { attemptId: string }) {
        const existed = handoffLeaseIdentities.delete(identity.attemptId);
        if (existed) handoffRecoveredCancellations.push(identity.attemptId);
        return { kind: existed ? "settled" as const : "already-settled" as const };
    },
    async snapshot() {
        return {};
    },
};
const handoffTransport = new ProviderTransportAdapter({ mode: "test", admission: handoffAdmission as never });
const handoffUnitGate = deferred<void>();
let handoffPreparedUnits = 0;
let firstHandoffGrantSnapshot: any;
let unboundRecoveryTaskId: string | undefined;
let unboundRecoveredAttemptId: string | undefined;
const handoffPump = new RecordSchedulerProductionPump({
    coordinatorOwnerId: "production-pump-handoff-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: handoffDataRoot },
    providerTransport: handoffTransport,
    onPhase: async event => {
        if (event.phase === "unit-prepared"
            && (event.taskId === blockedGrokTask.taskId || event.taskId === availableAgyTask.taskId)) {
            handoffPreparedUnits += 1;
            if (handoffPreparedUnits === 2) handoffUnitGate.resolve(undefined);
            await handoffUnitGate.promise;
        }
        if (event.phase === "unit-prepared" && event.taskId === unboundRecoveryTaskId && !unboundRecoveredAttemptId) {
            unboundRecoveredAttemptId = event.attemptId;
            handoffLeaseIdentities.set(event.attemptId, {
                provider: "agy",
                trafficClass: "record",
                attemptId: event.attemptId,
                leaseId: `stale-unbound-${event.attemptId}`,
                ownerEpoch: 1,
                capacityGeneration: 1,
                acquiredAt: Date.now() - 1_000,
                expiresAt: Date.now() + 120_000,
            });
        }
        if (event.phase === "grant-persisted" && event.taskId === availableAgyTask.taskId && !firstHandoffGrantSnapshot) {
            const stored = await readRecordSchedulerCoordinatorStore({ dataRoot: handoffDataRoot });
            if (stored.kind === "current") firstHandoffGrantSnapshot = structuredClone(stored.snapshot);
        }
    },
});
const blockedGrokInvokes = { count: 0 };
const blockedGrokSubmission = handoffPump.register(registration(blockedGrokTask, blockedGrokFixture))(routeCall("handoff-grok-blocked", {
    requestedChain: "auto",
    providers: [{
        provider: "grok",
        invoke: async () => {
            blockedGrokInvokes.count += 1;
            return { text: "must-not-run", chainUsed: "grok", modelUsed: "fake-grok-record" };
        },
    }],
}));
const availableAgyInvokes = { count: 0 };
const availableAgySubmission = handoffPump.register(registration(availableAgyTask, availableAgyFixture))(routeCall("handoff-agy-auto", {
    requestedChain: "auto",
    providers: [{
        provider: "agy",
        invoke: async options => {
            availableAgyInvokes.count += 1;
            const lease = options?.transportLease;
            if (!lease) throw new Error("handoff agy invoke requires a physical lease");
            return await handoffTransport.executeGranted(
                lease,
                async () => ({ text: "handoff-agy-success", chainUsed: "agy", modelUsed: "fake-agy-record" }),
                settled => settled.text === null ? "failure" : "success",
            );
        },
    }],
}));
const [blockedGrokSettlement, availableAgySettlement] = await Promise.allSettled([blockedGrokSubmission, availableAgySubmission]);
assert.equal(blockedGrokSettlement.status, "rejected");
if (blockedGrokSettlement.status === "rejected") {
    assert.equal(isBackgroundTaskSuspension(blockedGrokSettlement.reason), true, "provider-blocked Unit must return the typed suspension signal");
}
assert.equal(availableAgySettlement.status, "fulfilled");
if (availableAgySettlement.status === "fulfilled") assert.equal(availableAgySettlement.value.text, "handoff-agy-success");
assert.equal(blockedGrokInvokes.count, 0, "blocked Grok capacity must not reach provider invoke");
assert.equal(availableAgyInvokes.count, 1, "available agy must dispatch in the same coordinator handoff");
const blockedGrokLedger = await readRecordSchedulerLedgerStore(blockedGrokTask.taskId, { expectPublished: true });
const availableAgyLedger = await readRecordSchedulerLedgerStore(availableAgyTask.taskId, { expectPublished: true });
assert.equal(blockedGrokLedger.kind, "current");
assert.equal(availableAgyLedger.kind, "current");
if (blockedGrokLedger.kind === "current") {
    const blockedUnit = blockedGrokLedger.ledger.units.find(unit => unit.layer === "provider-attempt");
    assert.ok(blockedUnit, "blocked Grok request must retain its durable Unit");
    assert.equal(blockedGrokLedger.ledger.attempts.some(attempt => attempt.unitId === blockedUnit!.unitId), false, "blocked Grok capacity must not create a fake Attempt");
}
if (availableAgyLedger.kind === "current") {
    const attempts = availableAgyLedger.ledger.attempts.filter(attempt => attempt.provider === "agy");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.trafficClass, "agy-first-run-overflow");
    assert.equal(attempts[0]?.state, "KnownSuccess");
}
assert.ok(firstHandoffGrantSnapshot, "available agy grant must expose persisted fairness evidence");
assert.equal(firstHandoffGrantSnapshot.fairness.dispatchSeq, 1, "blocked Grok must not consume dispatchSeq before agy handoff");
const blockedFairnessRecord = firstHandoffGrantSnapshot.fairness.records.find((record: any) => record.taskId === blockedGrokTask.taskId);
const availableFairnessRecord = firstHandoffGrantSnapshot.fairness.records.find((record: any) => record.taskId === availableAgyTask.taskId);
assert.equal(blockedFairnessRecord?.serviceDebt, 0, "blocked Grok must not accrue service debt");
assert.equal(blockedFairnessRecord?.units[0]?.chargedCost, undefined, "blocked Grok must not reserve estimated cost");
assert.equal(availableFairnessRecord?.serviceDebt, 1, "available agy must receive exactly one charged service unit");
assert.equal(handoffTransport.diagnostics().attempts.some(attempt => attempt.provider === "grok"), false, "blocked Grok must not create transport diagnostics or lease state");

const overflowTryStart = handoffTryEvents.length;
const overflowInvokes = { grok: 0, agy: 0 };
const overflowResult = await handoffPump.register(registration(overflowAgyTask, overflowAgyFixture))(routeCall("handoff-grok-to-agy-overflow", {
    requestedChain: "auto",
    providers: [
        {
            provider: "grok",
            invoke: async () => {
                overflowInvokes.grok += 1;
                return { text: "must-not-run", chainUsed: "grok", modelUsed: "fake-grok-record" };
            },
        },
        {
            provider: "agy",
            invoke: async options => {
                overflowInvokes.agy += 1;
                const lease = options?.transportLease;
                if (!lease) throw new Error("first-run overflow agy invoke requires a physical lease");
                return await handoffTransport.executeGranted(
                    lease,
                    async () => ({ text: "first-run-overflow-success", chainUsed: "agy", modelUsed: "fake-agy-record" }),
                    settled => settled.text === null ? "failure" : "success",
                );
            },
        },
    ],
}));
assert.equal(overflowResult.text, "first-run-overflow-success");
assert.deepEqual(overflowInvokes, { grok: 0, agy: 1 }, "Grok capacity-full must overflow the same logical Unit to agy without invoking Grok");
const overflowTryEvents = handoffTryEvents.slice(overflowTryStart);
assert.deepEqual(
    overflowTryEvents.map(event => ({ provider: event.provider, trafficClass: event.trafficClass })),
    [
        { provider: "grok", trafficClass: "record" },
        { provider: "agy", trafficClass: "agy-first-run-overflow" },
    ],
    "one coordinator handoff must atomically try Grok and then agy first-run overflow",
);
assert.equal(overflowTryEvents[0]?.attemptId, overflowTryEvents[1]?.attemptId, "first-run overflow must preserve the same Attempt ordinal before any provider call starts");
const overflowLedger = await readRecordSchedulerLedgerStore(overflowAgyTask.taskId, { expectPublished: true });
assert.equal(overflowLedger.kind, "current");
if (overflowLedger.kind === "current") {
    const providerUnits = overflowLedger.ledger.units.filter(unit => unit.layer === "provider-attempt");
    const providerAttempts = overflowLedger.ledger.attempts.filter(attempt => providerUnits.some(unit => unit.unitId === attempt.unitId));
    assert.equal(providerUnits.length, 1, "first-run overflow must retain one logical Unit");
    assert.equal(providerAttempts.length, 1, "Grok capacity rejection must not create a fake Attempt");
    assert.equal(providerAttempts[0]?.provider, "agy");
    assert.equal(providerAttempts[0]?.trafficClass, "agy-first-run-overflow");
    assert.equal(providerAttempts[0]?.state, "KnownSuccess");
    assert.deepEqual(providerUnits[0]?.attemptedProviders, ["agy"]);
    assert.equal(providerUnits[0]?.routeCursor, 1);
}

const syntheticFallbackInvokes = { antigravity: 0, codex: 0 };
const syntheticFallbackResult = await handoffPump.register(registration(syntheticFallbackTask, syntheticFallbackFixture))(routeCall("handoff-antigravity-to-codex", {
    requestedChain: "auto",
    providers: [
        {
            provider: "antigravity",
            invoke: async () => {
                syntheticFallbackInvokes.antigravity += 1;
                return {
                    text: null,
                    error: "Antigravity LS unavailable",
                    failureClass: "Availability",
                    chainUsed: "antigravity",
                    modelUsed: "fake-antigravity-record",
                };
            },
        },
        {
            provider: "codex",
            invoke: async () => {
                syntheticFallbackInvokes.codex += 1;
                return { text: "synthetic-fallback-success", chainUsed: "codex", modelUsed: "fake-codex-record" };
            },
        },
    ],
}));
assert.equal(syntheticFallbackResult.text, "synthetic-fallback-success");
assert.deepEqual(syntheticFallbackInvokes, { antigravity: 1, codex: 1 });
const syntheticFallbackLedger = await readRecordSchedulerLedgerStore(syntheticFallbackTask.taskId, { expectPublished: true });
assert.equal(syntheticFallbackLedger.kind, "current");
if (syntheticFallbackLedger.kind === "current") {
    const providerUnits = syntheticFallbackLedger.ledger.units.filter(unit => unit.layer === "provider-attempt");
    assert.equal(providerUnits.length, 1, "Availability fallback across synthetic bridges must retain one logical Unit");
    assert.equal(providerUnits[0]?.childUnitIds?.length || 0, 0, "Availability must not split the logical Unit");
    assert.deepEqual(providerUnits[0]?.attemptedProviders, ["antigravity", "codex"]);
    const attempts = syntheticFallbackLedger.ledger.attempts
        .filter(attempt => attempt.unitId === providerUnits[0]?.unitId)
        .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
    assert.deepEqual(attempts.map(attempt => attempt.provider), ["antigravity", "codex"]);
    assert.deepEqual(attempts.map(attempt => attempt.state), ["KnownFailure", "KnownSuccess"]);
    assert.equal(attempts[0]?.errorClass, "Availability");
}

const explicitAgyFixture = createPumpFixture(handoffDataRoot, "handoff-agy-explicit");
const explicitAgyTask = await admitFixture(fixtureSource("production-pump-handoff-agy-explicit"), "handoff-owner-agy-explicit", explicitAgyFixture);
unboundRecoveryTaskId = explicitAgyTask.taskId;
const explicitAgyResult = await handoffPump.register(registration(explicitAgyTask, explicitAgyFixture))(routeCall("handoff-agy-explicit", {
    providers: [{
        provider: "agy",
        invoke: async options => {
            const lease = options?.transportLease;
            if (!lease) throw new Error("explicit agy invoke requires a physical lease");
            return await handoffTransport.executeGranted(
                lease,
                async () => ({ text: "explicit-agy-success", chainUsed: "agy", modelUsed: "fake-agy-record" }),
                settled => settled.text === null ? "failure" : "success",
            );
        },
    }],
}));
assert.equal(explicitAgyResult.text, "explicit-agy-success");
assert.ok(unboundRecoveredAttemptId, "Unit-prepared crash window fixture must seed a deterministic unbound provider lease");
assert.deepEqual(handoffRecoveredCancellations, [unboundRecoveredAttemptId], "fresh dispatch must cancel exactly the stale pre-intent lease before regrant");
assert.equal(handoffLeaseIdentities.has(unboundRecoveredAttemptId!), false, "stale and replacement provider leases must both be settled after success");
const explicitAgyLedger = await readRecordSchedulerLedgerStore(explicitAgyTask.taskId, { expectPublished: true });
assert.equal(explicitAgyLedger.kind, "current");
if (explicitAgyLedger.kind === "current") {
    assert.equal(explicitAgyLedger.ledger.attempts.find(attempt => attempt.provider === "agy")?.trafficClass, "record");
}
await handoffPump.close({ timeoutMs: 5_000 });
await releaseRuntimeHoldAndWait(blockedGrokFixture, blockedGrokTask.taskId, "blocked Grok handoff task");
await releaseRuntimeHoldAndWait(availableAgyFixture, availableAgyTask.taskId, "available agy handoff task");
await releaseRuntimeHoldAndWait(overflowAgyFixture, overflowAgyTask.taskId, "Grok-to-agy first-run overflow task");
await releaseRuntimeHoldAndWait(syntheticFallbackFixture, syntheticFallbackTask.taskId, "Antigravity-to-Codex fallback task");
await releaseRuntimeHoldAndWait(explicitAgyFixture, explicitAgyTask.taskId, "explicit agy handoff task");
assert.deepEqual(getBackgroundTaskQueueStatsForTest(), { active: 0, pending: 0 }, "handoff fixtures must release every background lane before concurrent tests");

const concurrentDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-concurrent-"));
const concurrentFixtureA = createPumpFixture(concurrentDataRoot, "concurrent-a");
const concurrentFixtureB = createPumpFixture(concurrentDataRoot, "concurrent-b");
const concurrentTaskA = await admitFixture(
    fixtureSource("production-pump-concurrent-a"),
    "production-pump-concurrent-owner-a",
    concurrentFixtureA,
    "record-batch-update",
);
const concurrentTaskB = await admitFixture(
    fixtureSource("production-pump-concurrent-b"),
    "production-pump-concurrent-owner-b",
    concurrentFixtureB,
    "record-batch-update",
);
assert.equal(concurrentTaskA.sourceSet.phase, "sealed", "concurrent A must finish discovery/source sealing before provider submission");
assert.equal(concurrentTaskB.sourceSet.phase, "sealed", "concurrent B must finish discovery/source sealing before provider submission");
const concurrentAdmissionQueue = backgroundTaskDiagnostics();
assert.equal(getBackgroundTask(concurrentTaskA.taskId)?.kind, "record-batch-update");
assert.equal(getBackgroundTask(concurrentTaskB.taskId)?.kind, "record-batch-update");
assert.equal(getBackgroundTask(concurrentTaskA.taskId)?.status, "running");
assert.equal(getBackgroundTask(concurrentTaskB.taskId)?.status, "running");
assert.equal(
    concurrentAdmissionQueue.lanes.recordBatchUpdate.active >= 2,
    true,
    `two independent runtime callbacks must be held concurrently in the real batch lane: ${JSON.stringify(concurrentAdmissionQueue)}`,
);
const concurrentAdmission = { acquires: 0, active: 0, assertCurrentCalls: 0 };
const concurrentAcquireEvents: Array<{
    ordinal: number;
    provider: "grok" | "agy";
    attemptId: string;
    leaseId: string;
}> = [];
const concurrentLeaseIdentities = new Map<string, {
    provider: "grok" | "agy";
    trafficClass: ProviderTrafficClass;
    attemptId: string;
    leaseId: string;
    ownerEpoch: number;
    capacityGeneration: number;
    acquiredAt: number;
    expiresAt: number;
}>();
const concurrentAttemptLabels = new Map<string, string>();
const concurrentExecuteGrantedAttemptIds = new Set<string>();
const concurrentTransport = new ProviderTransportAdapter({
    mode: "test",
    admission: {
        async tryAcquire(provider: "grok" | "agy", trafficClass: ProviderTrafficClass, invocation: { attemptId: string }) {
            concurrentAdmission.acquires += 1;
            concurrentAdmission.active += 1;
            const identity = {
                provider,
                trafficClass,
                attemptId: invocation.attemptId,
                leaseId: `concurrent-lease-${invocation.attemptId}`,
                ownerEpoch: 1,
                capacityGeneration: 1,
                acquiredAt: Date.now(),
                expiresAt: Date.now() + 120_000,
            } as const;
            concurrentAcquireEvents.push({
                ordinal: concurrentAdmission.acquires,
                provider,
                attemptId: invocation.attemptId,
                leaseId: identity.leaseId,
            });
            concurrentLeaseIdentities.set(invocation.attemptId, identity);
            let completed = false;
            return {
                leaseId: identity.leaseId,
                leaseIdentity: identity,
                async assertCurrent() {
                    concurrentAdmission.assertCurrentCalls += 1;
                    concurrentExecuteGrantedAttemptIds.add(invocation.attemptId);
                },
                async complete() {
                    if (!completed) {
                        completed = true;
                        concurrentAdmission.active -= 1;
                        concurrentLeaseIdentities.delete(invocation.attemptId);
                    }
                    return true;
                },
            };
        },
        async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
            const identity = concurrentLeaseIdentities.get(attemptId);
            return identity && identity.provider === provider ? { kind: "active" as const, identity } : { kind: "absent" as const };
        },
        async settleRecoveredLease(identity: { attemptId: string }) {
            const existing = concurrentLeaseIdentities.get(identity.attemptId);
            if (!existing) return { kind: "already-settled" as const };
            concurrentLeaseIdentities.delete(identity.attemptId);
            concurrentAdmission.active -= 1;
            return { kind: "settled" as const };
        },
        async cancelRecoveredLease(identity: { attemptId: string }) {
            const existing = concurrentLeaseIdentities.get(identity.attemptId);
            if (!existing) return { kind: "already-settled" as const };
            concurrentLeaseIdentities.delete(identity.attemptId);
            concurrentAdmission.active -= 1;
            return { kind: "settled" as const };
        },
        async snapshot() {
            return {};
        },
    } as never,
});
interface ConcurrentFairnessRecordEvidence {
    taskId: string;
    serviceDebt: number;
    waitingCredit: number;
    lastServedSeq?: number;
    window?: { startSeq: number; deadlineSeq: number; populationN: number };
    eligibleUnitIds: string[];
}

interface ConcurrentPhaseEvidence {
    ordinal: number;
    phase: string;
    taskId: string;
    unitId: string;
    attemptId: string;
    permitId?: string;
    dispatchSeq?: number;
    deadlineSeq?: number;
    outerScore?: number;
    fairnessDispatchSeq?: number;
    fairnessRecords: ConcurrentFairnessRecordEvidence[];
}

const concurrentPhases: ConcurrentPhaseEvidence[] = [];
const concurrentPump = new RecordSchedulerProductionPump({
    coordinatorOwnerId: "production-pump-concurrent-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: concurrentDataRoot },
    providerTransport: concurrentTransport,
    onPhase: async event => {
        let fairnessDispatchSeq: number | undefined;
        let fairnessRecords: ConcurrentFairnessRecordEvidence[] = [];
        if (event.phase === "intent-persisted" || event.phase === "grant-persisted") {
            const stored = await readRecordSchedulerCoordinatorStore({ dataRoot: concurrentDataRoot });
            if (stored.kind === "current") {
                fairnessDispatchSeq = stored.snapshot.fairness.dispatchSeq;
                fairnessRecords = stored.snapshot.fairness.records.map(record => ({
                    taskId: record.taskId,
                    serviceDebt: record.serviceDebt,
                    waitingCredit: record.waitingCredit,
                    lastServedSeq: record.lastServedSeq,
                    ...(record.window === undefined ? {} : { window: { ...record.window } }),
                    eligibleUnitIds: record.units.filter(unit => unit.status === "queued").map(unit => unit.unitId),
                }));
            }
        }
        concurrentPhases.push({
            ordinal: concurrentPhases.length + 1,
            phase: event.phase,
            taskId: event.taskId,
            unitId: event.unitId,
            attemptId: event.attemptId,
            permitId: event.claim?.permitId,
            dispatchSeq: event.claim?.dispatchSeq,
            deadlineSeq: event.claim?.candidate.deadlineSeq,
            outerScore: event.claim?.candidate.outerScore,
            fairnessDispatchSeq,
            fairnessRecords,
        });
    },
});
const concurrentInvokes: string[] = [];
function concurrentCall(
    logicalCallKey: string,
    invoke: () => Promise<RecordModelCallResult>,
): RecordSchedulerModelCallContext {
    return routeCall(logicalCallKey, {
        providers: [{
            provider: "grok",
            model: "fake-grok-concurrent",
            invoke: async options => {
                concurrentInvokes.push(logicalCallKey);
                const lease = options?.transportLease;
                const attemptId = options?.attemptId;
                if (!lease || !attemptId) throw new Error(`missing transport lease or attemptId for ${logicalCallKey}`);
                assert.equal(lease.attemptId, attemptId);
                concurrentAttemptLabels.set(attemptId, logicalCallKey);
                return await concurrentTransport.executeGranted(
                    lease,
                    invoke,
                    settled => settled.text === null ? "failure" : "success",
                );
            },
        }],
    });
}
const concurrentA1Result = deferred<RecordModelCallResult>();
const concurrentHookA = concurrentPump.register(registration(concurrentTaskA, concurrentFixtureA));
const concurrentHookB = concurrentPump.register(registration(concurrentTaskB, concurrentFixtureB));
for (const [label, task] of [["A", concurrentTaskA], ["B", concurrentTaskB]] as const) {
    const stored = await readRecordSchedulerLedgerStore(task.taskId, { expectPublished: true });
    assert.equal(stored.kind, "current");
    if (stored.kind === "current") {
        assert.equal(
            ["Succeeded", "Deferred", "FailedFinal", "Cancelled", "RepairRequired"].includes(stored.ledger.task.state),
            false,
            `concurrent ${label} scheduler task must remain non-terminal while provider Units are submitted`,
        );
    }
}
const concurrentA1 = concurrentHookA(concurrentCall("concurrent-a-1", async () => await concurrentA1Result.promise));
let concurrentA1Settlement: { kind: "fulfilled"; result: RecordModelCallResult } | { kind: "rejected"; error: unknown } | undefined;
void concurrentA1.then(
    result => { concurrentA1Settlement = { kind: "fulfilled", result }; },
    error => { concurrentA1Settlement = { kind: "rejected", error }; },
);
function concurrentExecuteGranted(logicalCallKey: string): boolean {
    return [...concurrentAttemptLabels.entries()].some(([attemptId, label]) => label === logicalCallKey && concurrentExecuteGrantedAttemptIds.has(attemptId));
}
async function concurrentDiagnostic(reason: string): Promise<string> {
    const [ledgerA, ledgerB] = await Promise.all([
        readRecordSchedulerLedgerStore(concurrentTaskA.taskId, { expectPublished: true }),
        readRecordSchedulerLedgerStore(concurrentTaskB.taskId, { expectPublished: true }),
    ]);
    const coordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: concurrentDataRoot });
    const ledgerEvidence = [
        { taskId: concurrentTaskA.taskId, stored: ledgerA },
        { taskId: concurrentTaskB.taskId, stored: ledgerB },
    ];
    const acquireEvents = concurrentAcquireEvents.map(event => {
        const owner = ledgerEvidence.flatMap(entry => entry.stored.kind === "current"
            ? entry.stored.ledger.attempts
                .filter(attempt => attempt.attemptId === event.attemptId)
                .map(attempt => ({
                    taskId: entry.taskId,
                    unitId: attempt.unitId,
                    state: attempt.state,
                    dispatchSeq: attempt.dispatchSeq,
                    dispatchPhase: attempt.dispatchPhase,
                }))
            : [])[0];
        return {
            ...event,
            logicalCallKey: concurrentAttemptLabels.get(event.attemptId) ?? null,
            ...(owner ?? { taskId: null, unitId: null, state: null, dispatchSeq: null, dispatchPhase: null }),
        };
    });
    return JSON.stringify({
        reason,
        concurrentA1Settlement: concurrentA1Settlement?.kind === "fulfilled"
            ? { kind: "fulfilled", result: concurrentA1Settlement.result }
            : concurrentA1Settlement?.kind === "rejected"
                ? { kind: "rejected", error: concurrentA1Settlement.error instanceof Error ? `${concurrentA1Settlement.error.name}: ${concurrentA1Settlement.error.message}` : String(concurrentA1Settlement.error) }
                : { kind: "pending" },
        invokes: concurrentInvokes,
        admission: concurrentAdmission,
        acquireEvents,
        phases: concurrentPhases,
        fakeActiveLeaseAttemptIds: [...concurrentLeaseIdentities.keys()].sort(),
        transport: concurrentTransport.diagnostics(),
        ledgers: ledgerEvidence.map(entry => entry.stored.kind === "current" ? {
            taskId: entry.taskId,
            taskState: entry.stored.ledger.task.state,
            attempts: entry.stored.ledger.attempts.map(attempt => ({ attemptId: attempt.attemptId, unitId: attempt.unitId, state: attempt.state, permitId: attempt.permitId, dispatchSeq: attempt.dispatchSeq, dispatchPhase: attempt.dispatchPhase })),
        } : { taskId: entry.taskId, stored: entry.stored }),
        coordinator: coordinator.kind === "current" ? {
            dispatchSeq: coordinator.snapshot.fairness.dispatchSeq,
            activeClaims: coordinator.snapshot.activeClaims.map(claim => ({ claimId: claim.claimId, attemptId: claim.attemptId, permitId: claim.permitId, dispatchSeq: claim.dispatchSeq, dispatchPhase: claim.dispatchPhase })),
        } : coordinator,
    });
}
async function waitForConcurrentExecution(logicalCallKey: string): Promise<void> {
    for (let index = 0; index < 200; index += 1) {
        if (concurrentExecuteGranted(logicalCallKey)) return;
        if (concurrentA1Settlement !== undefined) throw new Error(await concurrentDiagnostic(`${logicalCallKey} waited after concurrent A settled before its required execution handshake`));
        await sleep(10);
    }
    throw new Error(await concurrentDiagnostic(`${logicalCallKey} did not reach executeGranted/assertCurrent handshake`));
}
await waitForConcurrentExecution("concurrent-a-1");
assert.equal(concurrentInvokes.includes("concurrent-a-1"), true, "concurrent A handshake must originate from the model invoke path");
const concurrentB1 = concurrentHookB(concurrentCall("concurrent-b-1", async () => ({ text: "concurrent-b-1", chainUsed: "grok", modelUsed: "fake-grok-concurrent" })));
await waitForConcurrentExecution("concurrent-b-1");
assert.equal(concurrentA1Settlement, undefined, "task B must enter executeGranted while task A RPC remains unresolved");
const secondPermitDiagnostic = await concurrentDiagnostic("task B entered executeGranted while task A remained unresolved");
assert.equal(concurrentAdmission.acquires, 2, `task B must receive exactly the second real provider permit while A is unresolved: ${secondPermitDiagnostic}`);
assert.deepEqual(
    concurrentAcquireEvents.map(event => concurrentAttemptLabels.get(event.attemptId)),
    ["concurrent-a-1", "concurrent-b-1"],
    `the first two physical permits must belong to distinct A1/B1 Units: ${secondPermitDiagnostic}`,
);
const concurrentA2 = concurrentHookA(concurrentCall("concurrent-a-2", async () => ({ text: "concurrent-a-2", chainUsed: "grok", modelUsed: "fake-grok-concurrent" })));
const concurrentB2 = concurrentHookB(concurrentCall("concurrent-b-2", async () => ({ text: "concurrent-b-2", chainUsed: "grok", modelUsed: "fake-grok-concurrent" })));
await waitFor(() => concurrentPhases.filter(event => event.phase === "grant-persisted").length === 4, "all four concurrent claims must persist before releasing A");
const concurrentGrantOrder = concurrentPhases.filter(event => event.phase === "grant-persisted").slice(0, 4);
assert.deepEqual(concurrentGrantOrder.map(event => event.dispatchSeq), [1, 2, 3, 4]);
assert.deepEqual(
    concurrentGrantOrder.slice(0, 2).map(event => event.taskId),
    [concurrentTaskA.taskId, concurrentTaskB.taskId],
    "task B must receive service while task A's first RPC remains unresolved",
);
for (const task of [concurrentTaskA, concurrentTaskB]) {
    const taskGrants = concurrentGrantOrder.filter(event => event.taskId === task.taskId);
    assert.equal(taskGrants.length, 2, `bounded fairness must serve both Units for ${task.taskId} without starvation`);
    assert.equal(
        (taskGrants[1].dispatchSeq || 0) - (taskGrants[0].dispatchSeq || 0) <= 4,
        true,
        `two-record fairness must serve ${task.taskId} again within the 2N=4 permit bound`,
    );
}
for (const grant of concurrentGrantOrder) {
    const dispatchSeq = grant.dispatchSeq;
    assert.ok(dispatchSeq !== undefined);
    const intent = concurrentPhases.find(event => event.phase === "intent-persisted" && event.attemptId === grant.attemptId);
    assert.ok(intent, `grant ${grant.attemptId} must have a preceding durable dispatch intent`);
    assert.equal(intent.ordinal < grant.ordinal, true, `grant ${grant.attemptId} must follow its durable dispatch intent`);
    assert.equal(grant.fairnessDispatchSeq, dispatchSeq, `grant ${grant.attemptId} must expose the persisted coordinator dispatchSeq`);
    assert.ok(grant.deadlineSeq !== undefined, `grant ${grant.attemptId} must carry its frozen 2N deadline`);
    assert.equal(dispatchSeq <= grant.deadlineSeq, true, `grant ${grant.attemptId} must occur no later than its 2N deadline`);
    assert.equal(grant.deadlineSeq <= dispatchSeq + 3, true, `with at most two eligible records, ${grant.attemptId} must have a deadline no wider than 2N=4`);
    const selectedRecord = grant.fairnessRecords.find(record => record.taskId === grant.taskId);
    assert.ok(selectedRecord, `grant ${grant.attemptId} must retain selected-record fairness evidence`);
    assert.equal(Number.isFinite(selectedRecord.waitingCredit), true);
    assert.equal(
        selectedRecord.serviceDebt,
        concurrentGrantOrder.filter(event => (event.dispatchSeq || 0) <= dispatchSeq && event.taskId === grant.taskId).length,
        `grant ${grant.attemptId} must precharge exactly one unit of outer service debt`,
    );
    const skippedDueRecords = grant.fairnessRecords.filter(record => record.taskId !== grant.taskId
        && record.eligibleUnitIds.length > 0
        && record.window !== undefined
        && record.window.deadlineSeq <= dispatchSeq);
    assert.deepEqual(skippedDueRecords, [], `grant ${grant.attemptId} must not skip an eligible record whose 2N deadline is due`);
}
concurrentA1Result.resolve({ text: "concurrent-a-1", chainUsed: "grok", modelUsed: "fake-grok-concurrent" });
const concurrentResults = await Promise.all([concurrentA1, concurrentB1, concurrentA2, concurrentB2]);
assert.deepEqual(concurrentResults.map(result => result.text), ["concurrent-a-1", "concurrent-b-1", "concurrent-a-2", "concurrent-b-2"]);
assert.equal(concurrentAdmission.acquires, 4, "each concurrent provider attempt must acquire one physical lease");
for (const logicalCallKey of ["concurrent-a-1", "concurrent-b-1", "concurrent-a-2", "concurrent-b-2"]) {
    assert.equal(
        concurrentAcquireEvents.filter(event => concurrentAttemptLabels.get(event.attemptId) === logicalCallKey).length,
        1,
        `logical model Unit ${logicalCallKey} must acquire exactly one physical lease`,
    );
}
for (const acquire of concurrentAcquireEvents) {
    const matchingGrants = concurrentGrantOrder.filter(grant => grant.attemptId === acquire.attemptId);
    assert.equal(matchingGrants.length, 1, `physical lease ${acquire.leaseId} must bind exactly one persisted claim`);
    assert.equal(matchingGrants[0].permitId, acquire.leaseId, `physical lease ${acquire.leaseId} must match the persisted claim permitId`);
    assert.equal(`${matchingGrants[0].unitId}:attempt:1`, acquire.attemptId, `physical lease ${acquire.leaseId} must remain bound to its stable Unit/Attempt identity`);
}
assert.equal(concurrentAdmission.active, 0, "all concurrent provider leases must settle after their RPCs finish");
assert.equal(concurrentLeaseIdentities.size, 0, "all concurrent provider recovery identities must be settled after their RPCs finish");
assert.equal(concurrentTransport.diagnostics().attempts.every(attempt => attempt.permitSettled), true, "transport diagnostics must report no outstanding concurrent lease");
concurrentFixtureA.runtimeHolds.get(concurrentTaskA.taskId)?.resolve(undefined);
concurrentFixtureB.runtimeHolds.get(concurrentTaskB.taskId)?.resolve(undefined);
for (const task of [concurrentTaskA, concurrentTaskB]) {
    let reachedTerminal = false;
    for (let index = 0; index < 200; index += 1) {
        const stored = await readRecordSchedulerLedgerStore(task.taskId, { expectPublished: true });
        if (stored.kind === "current" && stored.ledger.task.state === "Succeeded") {
            reachedTerminal = true;
            break;
        }
        await sleep(10);
    }
    assert.equal(reachedTerminal, true, `concurrent task ${task.taskId} must reach Succeeded only after its runtime hold is released`);
}
await concurrentPump.close({ timeoutMs: 5_000 });
await concurrentTransport.close();

async function assertPermitGrantFailure(kind: "acquire" | "identity"): Promise<void> {
    const fixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), `mstore-record-scheduler-production-pump-permit-${kind}-`)));
    const task = await admitFixture(fixtureSource(`production-pump-permit-${kind}`), "production-pump-task-owner", fixture);
    const activeLeaseIdentities = new Map<string, {
        provider: "grok" | "agy";
        trafficClass: ProviderTrafficClass;
        attemptId: string;
        leaseId: string;
        ownerEpoch: number;
        capacityGeneration: number;
        acquiredAt: number;
        expiresAt: number;
    }>();
    const stats = { acquires: 0, invokes: 0, completes: 0, recoveredCancels: 0, active: 0 };
    const admission = {
        async tryAcquire(provider: "grok" | "agy", trafficClass: ProviderTrafficClass, invocation: { attemptId: string }) {
            stats.acquires += 1;
            if (kind === "acquire") throw new Error("injected provider acquire rejection");
            const actualIdentity = {
                provider,
                trafficClass,
                attemptId: invocation.attemptId,
                leaseId: `permit-${kind}-${invocation.attemptId}`,
                ownerEpoch: 9,
                capacityGeneration: 3,
                acquiredAt: Date.now(),
                expiresAt: Date.now() + 120_000,
            } as const;
            const advertisedIdentity = { ...actualIdentity, attemptId: `tampered-${invocation.attemptId}` } as const;
            activeLeaseIdentities.set(invocation.attemptId, actualIdentity);
            stats.active += 1;
            let completed = false;
            return {
                leaseId: actualIdentity.leaseId,
                leaseIdentity: advertisedIdentity,
                async assertCurrent() {},
                async complete() {
                    if (!completed) {
                        completed = true;
                        stats.completes += 1;
                        stats.active -= 1;
                        activeLeaseIdentities.delete(invocation.attemptId);
                    }
                    return true;
                },
            };
        },
        async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
            const identity = activeLeaseIdentities.get(attemptId);
            return identity && identity.provider === provider ? { kind: "active" as const, identity } : { kind: "absent" as const };
        },
        async settleRecoveredLease(identity: { attemptId: string }) {
            const existing = activeLeaseIdentities.get(identity.attemptId);
            if (!existing) return { kind: "already-settled" as const };
            activeLeaseIdentities.delete(identity.attemptId);
            stats.active -= 1;
            return { kind: "settled" as const };
        },
        async cancelRecoveredLease(identity: { attemptId: string }) {
            stats.recoveredCancels += 1;
            return await admission.settleRecoveredLease(identity);
        },
        async snapshot() {
            return {};
        },
    };
    const transport = new ProviderTransportAdapter({ mode: "test", admission: admission as never });
    const pump = new RecordSchedulerProductionPump({
        coordinatorOwnerId: `production-pump-permit-${kind}-coordinator`,
        coordinatorLeaseMs: 60_000,
        coordinatorStore: { dataRoot: fixture.dataRoot },
        providerTransport: transport,
    });
    const hook = pump.register(registration(task, fixture));
    await assert.rejects(
        () => hook(routeCall(`permit-${kind}-failure`, {
            providers: [{
                provider: "grok",
                model: "fake-grok-permit-failure",
                invoke: async () => {
                    stats.invokes += 1;
                    return { text: "must-not-invoke-permit-failure", chainUsed: "grok", modelUsed: "fake-grok-permit-failure" };
                },
            }],
        })),
        error => (error as { code?: unknown }).code === "REPAIR_REQUIRED",
    );
    assert.equal(stats.acquires, 1, `${kind} permit failure must attempt one physical acquire`);
    assert.equal(stats.invokes, 0, `${kind} permit failure must not invoke provider RPC`);
    assert.equal(stats.active, 0, `${kind} permit failure must leave no active physical lease`);
    assert.equal(activeLeaseIdentities.size, 0, `${kind} permit failure must leave no provider recovery identity`);
    if (kind === "identity") {
        assert.equal(stats.completes, 1, "invalid lease identity must cancel the acquired permit");
        assert.equal(stats.recoveredCancels, 1, "invalid lease identity must fence-settle the recovery receipt");
    }
    const ledger = await readRecordSchedulerLedgerStore(task.taskId, { expectPublished: true });
    assert.equal(ledger.kind, "current");
    if (ledger.kind === "current") assert.equal(ledger.ledger.task.state, "RepairRequired");
    const coordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: fixture.dataRoot });
    assert.equal(coordinator.kind, "current");
    if (coordinator.kind === "current") assert.equal(coordinator.snapshot.activeClaims.length, 0, `${kind} permit failure must not persist an active coordinator claim`);
    assert.equal(transport.diagnostics().attempts.every(attempt => attempt.permitSettled), true, `${kind} permit failure must leave transport diagnostics settled`);
    fixture.runtimeHolds.get(task.taskId)?.resolve(undefined);
    await pump.close({ timeoutMs: 5_000 });
    await transport.close();
}

await assertPermitGrantFailure("acquire");
await assertPermitGrantFailure("identity");

async function assertFreshPumpPhaseRecovery(
    phase: "attempt-bound" | "invoking",
    recoveryKind: "active" | "corrupt" = "active",
): Promise<void> {
    const recoveryFixtureKey = `${phase}-${recoveryKind}`;
    const fixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), `mstore-record-scheduler-production-pump-recovery-${recoveryFixtureKey}-`)));
    const task = await admitFixture(fixtureSource(`production-pump-recovery-${recoveryFixtureKey}`), "production-pump-task-owner", fixture);
    const registrationForRecovery = registration(task, fixture);
    const recoveryLeases = new Map<string, {
        provider: "grok" | "agy";
        trafficClass: ProviderTrafficClass;
        attemptId: string;
        leaseId: string;
        ownerEpoch: number;
        capacityGeneration: number;
        acquiredAt: number;
        expiresAt: number;
    }>();
    const recoveryStats = { invokes: 0, recoverCalls: 0, cancelRecoveredCalls: 0 };
    const recoveryAdmission = {
        async tryAcquire(provider: "grok" | "agy", trafficClass: ProviderTrafficClass, invocation: { attemptId: string }) {
            const identity = {
                provider,
                trafficClass,
                attemptId: invocation.attemptId,
                leaseId: `recovery-lease-${invocation.attemptId}`,
                ownerEpoch: 7,
                capacityGeneration: 11,
                acquiredAt: Date.now(),
                expiresAt: Date.now() + 120_000,
            } as const;
            recoveryLeases.set(invocation.attemptId, identity);
            return {
                leaseId: identity.leaseId,
                leaseIdentity: identity,
                async assertCurrent() {},
                async complete() {
                    recoveryLeases.delete(invocation.attemptId);
                    return true;
                },
            };
        },
        async recoverAttempt(provider: "grok" | "agy", attemptId: string) {
            recoveryStats.recoverCalls += 1;
            const identity = recoveryLeases.get(attemptId);
            if (recoveryKind === "corrupt" && identity && identity.provider === provider) {
                return { kind: "corrupt" as const, detail: "injected provider-control corruption" };
            }
            return identity && identity.provider === provider ? { kind: "active" as const, identity } : { kind: "absent" as const };
        },
        async settleRecoveredLease(identity: { attemptId: string }) {
            const existing = recoveryLeases.get(identity.attemptId);
            if (!existing) return { kind: "already-settled" as const };
            recoveryLeases.delete(identity.attemptId);
            return { kind: "settled" as const };
        },
        async cancelRecoveredLease(identity: { attemptId: string }) {
            recoveryStats.cancelRecoveredCalls += 1;
            const existing = recoveryLeases.get(identity.attemptId);
            if (!existing) return { kind: "already-settled" as const };
            recoveryLeases.delete(identity.attemptId);
            return { kind: "settled" as const };
        },
        async snapshot() {
            return {};
        },
    };
    const oldTransport = new ProviderTransportAdapter({ mode: "test", admission: recoveryAdmission as never });
    const freshTransport = new ProviderTransportAdapter({ mode: "test", admission: recoveryAdmission as never });
    const oldPumpStall = deferred<void>();
    const recoveryCoordinatorLeaseMs = 1_000;
    let persistedPhase = false;
    const oldPump = new RecordSchedulerProductionPump({
        coordinatorOwnerId: `production-pump-recovery-${recoveryFixtureKey}-old`,
        coordinatorLeaseMs: recoveryCoordinatorLeaseMs,
        coordinatorStore: { dataRoot: fixture.dataRoot },
        providerTransport: oldTransport,
        onCoordinatorPersist: async event => {
            const claim = event.snapshot.activeClaims[0];
            if (!persistedPhase && event.phase === "after-write" && claim?.dispatchPhase === phase) {
                persistedPhase = true;
                await oldPumpStall.promise;
            }
        },
    });
    const logicalCallKey = `recovery-${recoveryFixtureKey}-logical-call`;
    const recoveryCall = (
        counters: { invokes: number },
        invocationTransport: ProviderTransportAdapter,
        allowProvenPreInvokeRetry = false,
    ): RecordSchedulerModelCallContext => routeCall(logicalCallKey, {
        retryBudget: 1,
        providers: [{
            provider: "grok",
            model: "fake-grok-recovery",
            invoke: async options => {
                counters.invokes += 1;
                recoveryStats.invokes += 1;
                if (!allowProvenPreInvokeRetry) {
                    throw new Error(`recovery fixture must never reach provider POST during ${phase}`);
                }
                assert.match(options?.attemptId || "", /:attempt:2$/u, "proven pre-invoke recovery must rotate to Attempt 2");
                assert.equal(options?.transportLease?.attemptId, options?.attemptId);
                const result = { text: `recovered-${phase}`, chainUsed: "grok" as const, modelUsed: "fake-grok-recovery" };
                if (!options?.transportLease) return result;
                return await invocationTransport.executeGranted(
                    options.transportLease,
                    async () => result,
                    settled => settled.text === null ? "failure" : "success",
                );
            },
        }],
    });
    const originalCounters = { invokes: 0 };
    let oldSubmissionSettled = false;
    let oldSubmissionError: unknown;
    const oldSubmission = oldPump.register(registrationForRecovery)(recoveryCall(originalCounters, oldTransport));
    void oldSubmission.then(
        () => { oldSubmissionSettled = true; },
        error => {
            oldSubmissionError = error;
            oldSubmissionSettled = true;
        },
    );
    await waitFor(
        () => persistedPhase || oldSubmissionSettled,
        `${phase} recovery fixture must durably persist its active claim or fail explicitly before simulating a process crash`,
    );
    if (!persistedPhase) {
        const failedLedger = await readRecordSchedulerLedgerStore(task.taskId, { expectPublished: true });
        const failedCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: fixture.dataRoot });
        throw new Error(
            `${phase} recovery fixture failed before persisted phase: ${oldSubmissionError instanceof Error ? `${oldSubmissionError.name}:${oldSubmissionError.message}` : String(oldSubmissionError)}; ledger=${JSON.stringify(failedLedger)}; coordinator=${JSON.stringify(failedCoordinator)}`,
        );
    }
    const beforeRestartCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: fixture.dataRoot });
    assert.equal(beforeRestartCoordinator.kind, "current");
    if (beforeRestartCoordinator.kind !== "current") throw new Error("restart fixture requires a current coordinator snapshot");
    await sleep(recoveryCoordinatorLeaseMs + 100);
    const freshPump = new RecordSchedulerProductionPump({
        coordinatorOwnerId: `production-pump-recovery-${recoveryFixtureKey}-fresh`,
        coordinatorLeaseMs: 60_000,
        coordinatorRestartCreditCapMs: 250,
        coordinatorStore: { dataRoot: fixture.dataRoot },
        providerTransport: freshTransport,
    });
    const replayCounters = { invokes: 0 };
    const freshHook = freshPump.register(registrationForRecovery);
    if (recoveryKind === "corrupt") {
        await assert.rejects(
            () => freshHook(recoveryCall(replayCounters, freshTransport)),
            error => (error as { code?: unknown }).code === "REPAIR_REQUIRED",
        );
    } else if (phase === "attempt-bound") {
        const recovered = await freshHook(recoveryCall(replayCounters, freshTransport, true));
        assert.equal(recovered.text, "recovered-attempt-bound");
    } else {
        await assert.rejects(
            () => freshHook(recoveryCall(replayCounters, freshTransport)),
            error => (error as { code?: unknown }).code === "UNKNOWN_OUTCOME",
        );
    }
    assert.equal(originalCounters.invokes, 0, `${phase} crash fixture must stop before provider POST`);
    assert.equal(replayCounters.invokes, recoveryKind === "active" && phase === "attempt-bound" ? 1 : 0, `${phase} recovery may only POST the proven pre-invoke retry`);
    const recoveredLedger = await readRecordSchedulerLedgerStore(task.taskId, { expectPublished: true });
    assert.equal(recoveredLedger.kind, "current");
    if (recoveredLedger.kind === "current") {
        const attempts = recoveredLedger.ledger.attempts.filter(candidate => candidate.model === "fake-grok-recovery");
        const initialAttempt = attempts.find(candidate => candidate.attemptId.endsWith(":attempt:1"));
        const retryAttempt = attempts.find(candidate => candidate.attemptId.endsWith(":attempt:2"));
        const unit = recoveredLedger.ledger.units.find(candidate => candidate.unitId === initialAttempt?.unitId);
        assert.equal(initialAttempt?.state, recoveryKind === "corrupt" ? "Dispatched" : phase === "attempt-bound" ? "KnownFailure" : "UnknownOutcome");
        assert.equal(unit?.state, recoveryKind === "corrupt" ? "Running" : phase === "attempt-bound" ? "ResultReady" : "UnknownOutcome");
        if (recoveryKind === "active" && phase === "attempt-bound") {
            assert.equal(retryAttempt?.state, "KnownSuccess", "proven pre-invoke recovery must persist Attempt 2 success");
            assert.ok((retryAttempt?.fence.fencingToken || 0) > (initialAttempt?.fence.fencingToken || 0), "pre-invoke retry must advance the logical work fence");
        } else {
            assert.equal(retryAttempt, undefined, "unsafe or corrupt recovery must not create Attempt 2");
        }
        if (phase === "invoking") assert.ok(initialAttempt?.unknownOutcomeUntil, "invoking recovery must persist the UnknownOutcome grace fence");
    }
    const recoveredCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: fixture.dataRoot });
    assert.equal(recoveredCoordinator.kind, "current");
    if (recoveredCoordinator.kind === "current") {
        assert.equal(recoveredCoordinator.snapshot.activeClaims.length, recoveryKind === "corrupt" ? 1 : 0, `${phase} recovery must remove the stale running fairness claim unless provider control is corrupt`);
    }
    assert.equal(recoveryStats.recoverCalls >= 1, true, `${phase} recovery must query provider control`);
    assert.equal(recoveryStats.cancelRecoveredCalls, recoveryKind === "active" && phase === "attempt-bound" ? 1 : 0, "only confirmed pre-invoke active leases may be fenced-cancelled");
    assert.equal(recoveryStats.invokes, recoveryKind === "active" && phase === "attempt-bound" ? 1 : 0, "provider recovery may only POST the proven pre-invoke retry");
    if (recoveryKind === "active" && phase === "attempt-bound") assert.equal(recoveryLeases.size, 0, "pre-invoke recovery must settle the physical lease before requeueing");
    fixture.runtimeHolds.get(task.taskId)?.resolve(undefined);
    oldPumpStall.resolve(undefined);
    await waitFor(() => oldSubmissionSettled, `${phase} stale owner submission must settle after its simulated process stall is released`);
    assert.ok(oldSubmissionError, `${phase} stale owner must be fenced after the fresh coordinator takes over`);
    await oldPump.close({ timeoutMs: 5_000 });
    await freshPump.close({ timeoutMs: 5_000 });
    await oldTransport.close();
    await freshTransport.close();
}

await assertFreshPumpPhaseRecovery("attempt-bound");
await assertFreshPumpPhaseRecovery("invoking");
await assertFreshPumpPhaseRecovery("attempt-bound", "corrupt");

const cancellationTask = await admitFixture(fixtureSource("production-pump-cancelled"), "production-pump-task-owner", mainFixture);
const cancellationHook = pump.register(registration(cancellationTask));
const cancellationCounters = { invokes: 0 };
await control.cancel(cancellationTask.taskId);
const cancelled = await cancellationHook(call("logical-cancelled", "must-not-invoke-after-cancel", cancellationCounters));
assert.equal(cancelled.cancelled, true);
assert.equal(cancellationCounters.invokes, 0, "cancelled task must not dispatch a provider Unit");
await releaseRuntimeHoldAndWait(mainFixture, cancellationTask.taskId, "dedicated cancellation task");

const storedCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot });
assert.equal(storedCoordinator.kind, "current");
if (storedCoordinator.kind === "current") {
    const expectedDispatchSeq = Math.max(...phases.filter(event => event.phase === "grant-persisted").map(event => event.dispatchSeq || 0));
    assert.equal(storedCoordinator.snapshot.fairness.dispatchSeq, expectedDispatchSeq, "settled claims must preserve fairness dispatch sequence in durable snapshot");
    const currentA = await readRecordSchedulerLedgerStore(taskA.taskId, { expectPublished: true });
    const currentB = await readRecordSchedulerLedgerStore(taskB.taskId, { expectPublished: true });
    assert.equal(currentA.kind, "current");
    assert.equal(currentB.kind, "current");
    if (currentA.kind === "current" && currentB.kind === "current") {
        const restarted = new RecordSchedulerCoordinator();
        await restarted.rebuild([currentA.ledger, currentB.ledger], { snapshot: storedCoordinator.snapshot });
        assert.equal(restarted.snapshot().repairRequired, false, "coordinator restart must accept settled production UnknownOutcome evidence without recreating a claim");
        assert.equal(restarted.snapshot().fairness.dispatchSeq, expectedDispatchSeq, "coordinator restart must preserve durable fairness dispatch sequence");
    }
}
assert.ok(cancelCount >= 0);

const lifecycleFixture = createPumpFixture(fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-production-pump-lifecycle-")));
const lifecycleTask = await admitFixture(fixtureSource("production-pump-lifecycle"), "production-pump-task-owner", lifecycleFixture);
const lifecycleOptions = {
    coordinatorOwnerId: "production-pump-lifecycle-coordinator",
    coordinatorLeaseMs: 60_000,
    coordinatorStore: { dataRoot: lifecycleFixture.dataRoot },
    providerTransport: transport,
};
const lifecyclePump = getRecordSchedulerProductionPump(lifecycleOptions);
const lifecycleHook = lifecyclePump.register(registration(lifecycleTask, lifecycleFixture));
const lifecycleProviderResult = deferred<RecordModelCallResult>();
const lifecycleCounters = { invokes: 0 };
const lifecycleSubmission = lifecycleHook(routeCall("lifecycle-invoking", {
    providers: [{
        provider: "grok",
        invoke: async options => {
            lifecycleCounters.invokes += 1;
            const lease = options?.transportLease;
            if (!lease) throw new Error("lifecycle test requires the granted physical provider lease");
            return await transport.executeGranted(
                lease,
                async () => await lifecycleProviderResult.promise,
                settled => settled.text === null ? "failure" : "success",
            );
        },
    }],
}));
await waitFor(() => lifecycleCounters.invokes === 1, "lifecycle quiesce fixture must reach an invoking provider RPC");
const lifecycleHandoff = await quiesceRecordSchedulerProductionSessions({ timeoutMs: 5_000 });
assert.equal(lifecycleHandoff.acceptingDispatches, false, "quiesce must stop new coordinator claims and dispatches");
assert.equal(lifecycleHandoff.invokingAttemptIds.length >= 1, true, "quiesce handoff must expose invoking RPC attempts without aborting them");
await assert.rejects(
    () => lifecycleHook(call("lifecycle-rejected", "must-not-dispatch", lifecycleCounters)),
    error => (error as { code?: unknown }).code === "OWNER_UNAVAILABLE",
);
assert.equal(lifecycleCounters.invokes, 1, "quiesce must reject a new hook call before a provider invoke");
lifecycleProviderResult.resolve({ text: "lifecycle-complete", chainUsed: "grok", modelUsed: "fake-grok-record" });
assert.equal((await lifecycleSubmission).text, "lifecycle-complete", "quiesce must not abort an already invoking provider RPC");
const closedHandoff = await closeRecordSchedulerProductionSessions({ timeoutMs: 5_000 });
assert.equal(closedHandoff.closed, true, "close must report the registry cleanup state");
const releasedCoordinator = await readRecordSchedulerCoordinatorStore({ dataRoot: lifecycleFixture.dataRoot });
assert.equal(releasedCoordinator.kind, "current");
assert.equal(releasedCoordinator.kind === "current" ? releasedCoordinator.envelope.ownerLease : undefined, null, "graceful close must release an idle coordinator owner immediately for hot restart");
const closedAgain = await closeRecordSchedulerProductionSessions({ timeoutMs: 5_000 });
assert.equal(closedAgain.closed, true, "repeated production session close must be idempotent");
const lifecycleReplacement = getRecordSchedulerProductionPump(lifecycleOptions);
assert.notEqual(lifecycleReplacement, lifecyclePump, "global close must remove the closed pump from the lifecycle registry");
await closeRecordSchedulerProductionSessions({ timeoutMs: 5_000 });
lifecycleFixture.runtimeHolds.get(lifecycleTask.taskId)?.resolve(undefined);

console.log("record scheduler production pump tests passed");
