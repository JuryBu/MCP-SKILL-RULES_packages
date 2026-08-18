import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { RecordSourceIdentity } from "../src/record-discovery.ts";
import type { RecordSchedulerProductionRegistration } from "../src/record-scheduler-production-pump.ts";
import type { FrozenRuntimeSourceSet } from "../src/record-scheduler-runtime.ts";
import type { RecordSchedulerModelCallContext } from "../src/record-types.ts";

const AGY_MODEL = "Gemini 3.5 Flash (High)";
const DEAD_GROK_PROXY_URL = "http://127.0.0.1:9";
const GROK_MODEL = "grok-4.5";
const GROK_TIMEOUT_MS = 10_000;
const AGY_TIMEOUT_MS = 180_000;
const LIVE_FALLBACK_SENTINEL = "PLAN_37_LIVE_FALLBACK_OK";

interface Deferred<Value> {
    promise: Promise<Value>;
    resolve(value: Value): void;
    reject(error: unknown): void;
}

interface LiveFallbackResult {
    taskId: string;
    ledgerPath: string;
    commitId: string;
    attempts: Array<{
        attemptId: string;
        unitId: string;
        provider: string;
        state: string;
        failureClass?: string;
        trafficClass?: string;
    }>;
}

type SchedulerInvokeOptions = Parameters<RecordSchedulerModelCallContext["providerCalls"][number]["invoke"]>[0];
type SchedulerInvocation = Required<NonNullable<SchedulerInvokeOptions>>;

function deferred<Value>(): Deferred<Value> {
    let resolvePromise!: (value: Value) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<Value>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function restoreEnvironment(name: string, original: string | undefined): void {
    if (original === undefined) delete process.env[name];
    else process.env[name] = original;
}

function fixtureSource(): RecordSourceIdentity {
    return {
        host: "codex",
        identity: {
            workspace: {
                workspaceId: "plan-37-live-fallback",
                canonicalPath: "C:/fixtures/plan-37-live-fallback",
            },
            source: {
                kind: "filesystem",
                authority: "C:/fixtures/plan-37-live-fallback/authority",
                authoritativeRoot: "C:/fixtures/plan-37-live-fallback/authority",
                canonicalPath: "C:/fixtures/plan-37-live-fallback/store",
            },
            conversationId: "plan-37-live-fallback",
        },
    };
}

function requireSchedulerInvocation(options: SchedulerInvokeOptions, provider: "grok" | "agy"): SchedulerInvocation {
    assert.ok(options?.transportLease, `${provider} must receive the production scheduler provider lease`);
    assert.ok(options.attemptId, `${provider} must receive the production scheduler attemptId`);
    assert.ok(options.idempotencyKey, `${provider} must receive the production scheduler idempotencyKey`);
    assert.ok(options.transportLease.trafficClass, `${provider} must receive the production scheduler trafficClass`);
    assert.equal(options.transportLease.attemptId, options.attemptId, `${provider} lease must bind the scheduler Attempt`);
    return options as SchedulerInvocation;
}

function buildRouteCall(prompt: string, callModelResponse: typeof import("../src/model-bridge.ts").callModelResponse): RecordSchedulerModelCallContext {
    const invokeGrok = async (modelPrompt: string, options?: SchedulerInvokeOptions) => {
        const invocation = requireSchedulerInvocation(options, "grok");
        return await callModelResponse(GROK_MODEL, modelPrompt, "grok", GROK_TIMEOUT_MS, {
            grokContext: "record",
            providerLease: invocation.transportLease,
            attemptId: invocation.attemptId,
            idempotencyKey: invocation.idempotencyKey,
            providerTrafficClass: invocation.transportLease.trafficClass,
        });
    };
    const invokeAgy = async (modelPrompt: string, options?: SchedulerInvokeOptions) => {
        const invocation = requireSchedulerInvocation(options, "agy");
        return await callModelResponse(AGY_MODEL, modelPrompt, "agy", AGY_TIMEOUT_MS, {
            providerLease: invocation.transportLease,
            attemptId: invocation.attemptId,
            idempotencyKey: invocation.idempotencyKey,
            providerTrafficClass: invocation.transportLease.trafficClass,
        });
    };

    return {
        logicalCallKey: "plan-37-live-grok-availability-to-agy",
        prompt,
        routePlan: ["grok", "agy"],
        providerCalls: [
            {
                provider: "grok",
                model: GROK_MODEL,
                logicalTimeout: GROK_TIMEOUT_MS + AGY_TIMEOUT_MS,
                invokeTimeout: GROK_TIMEOUT_MS,
                invoke: async options => await invokeGrok(prompt, options),
                invokePrompt: invokeGrok,
            },
            {
                provider: "agy",
                model: AGY_MODEL,
                logicalTimeout: GROK_TIMEOUT_MS + AGY_TIMEOUT_MS,
                invokeTimeout: AGY_TIMEOUT_MS,
                invoke: async options => await invokeAgy(prompt, options),
                invokePrompt: invokeAgy,
            },
        ],
        recipe: {
            recipeVersion: 1,
            templateId: "record-scheduler-live-fallback/v1",
            range: { axis: "round", start: 1, end: 2 },
            composeOrder: 0,
        },
        retryBudget: 0,
        splitPrompt: range => `${prompt}\n\n[split ${range.axis} ${range.start}-${range.end}]`,
        provider: "grok",
        model: GROK_MODEL,
        logicalTimeout: GROK_TIMEOUT_MS + AGY_TIMEOUT_MS,
        invokeTimeout: GROK_TIMEOUT_MS,
        retryOrdinal: 0,
        invoke: async options => await invokeGrok(prompt, options),
        trafficClass: "record-batch",
        context: {
            requestedChain: "auto",
            background: true,
            providerTrafficClass: "record",
            grokContext: "record",
        },
    };
}

async function main(): Promise<void> {
    if (process.env.MEMORY_STORE_RUN_LIVE_FALLBACK !== "1") {
        throw new Error("拒绝运行真实 Plan_37 fallback 验收；仅在 MEMORY_STORE_RUN_LIVE_FALLBACK=1 时启用");
    }

    const originalDataRoot = process.env.MEMORY_STORE_DATA_ROOT;
    const originalGrokProxyUrl = process.env.MEMORY_STORE_GROK_PROXY_URL;
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mstore-record-scheduler-live-fallback-"));
    let resetProviderTransportAdapterForTest: (() => Promise<void>) | undefined;
    let closeRecordSchedulerProductionSessions: ((options?: { timeoutMs?: number }) => Promise<unknown>) | undefined;
    let providerAdapterConfigured = false;

    try {
        process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
        process.env.MEMORY_STORE_GROK_PROXY_URL = DEAD_GROK_PROXY_URL;

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
            closeRecordSchedulerProductionSessions: closeSessions,
            createRecordSchedulerProductionSession,
        } = await import("../src/record-scheduler-production-pump.ts");
        const { callModelResponse } = await import("../src/model-bridge.ts");
        const {
            configureProviderTransportAdapterForTest,
            getProviderTransportAdapter,
            resetProviderTransportAdapterForTest: resetAdapter,
        } = await import("../src/provider-transport-adapter.ts");
        const { initializeProviderControlStore } = await import("../src/provider-control-store.ts");
        const { getRecordCommitArtifactRelativePath, readRecordCommitBodyArtifact } = await import("../src/record-store.ts");
        const { readRecordSchedulerLedgerStore } = await import("../src/record-scheduler-store.ts");

        resetProviderTransportAdapterForTest = resetAdapter;
        closeRecordSchedulerProductionSessions = closeSessions;

        await initializeProviderControlStore({ dataRoot, initialization: "exclusive-install" });
        const transport = await configureProviderTransportAdapterForTest({
            mode: "enforced",
            dataRoot,
            ownerId: `record-scheduler-live-fallback-${process.pid}`,
        });
        providerAdapterConfigured = true;
        assert.equal(transport.diagnostics().mode, "enforced", "live fallback must use the enforced provider transport");
        assert.equal(getProviderTransportAdapter(), transport, "model bridge must consume the same scheduler transport adapter");

        const source = fixtureSource();
        const observedAt = "2026-07-16T00:00:00.000Z";
        const discoveryInput = () => {
            const enumeration = buildSourceEnumerationEvidence({
                adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
                host: source.host,
                identity: source.identity,
                sourceRevision: { revision: "plan-37-revision", contentCursor: "plan-37-cursor", eventWatermark: "plan-37-event", sequence: 1 },
                pagination: { cursor: null, pages: 1, limit: null, truncated: false },
                enumerationComplete: true,
                cacheBypassed: true,
                exactFetchResult: "present",
                errors: [],
                warnings: [],
                observedAt: { scanId: "plan-37-live-fallback-scan", sequence: 1, startedAt: observedAt, completedAt: observedAt },
                targetStatus: "present",
            });
            const scope = buildRecordIndexScope({
                workspace: source.identity.workspace,
                snapshotId: "plan-37-live-fallback-index",
                indexRevision: "plan-37-index-revision",
                complete: true,
                paginationComplete: true,
                error: null,
                extensions: {},
            });
            const entry = buildRecordIndexEntry({
                recordId: "record-plan-37-live-fallback",
                source,
                indexSnapshotId: scope.snapshotId,
                indexRevision: scope.indexRevision,
                coveredRevision: { revision: "plan-37-previous", sequence: 0 },
                recordBodyHash: `sha256:${createHash("sha256").update(source.identity.conversationId).digest("hex")}`,
                extensions: {},
            });
            return {
                request: { snapshotId: "plan-37-live-fallback-discovery", discoveredAtSequence: 1, filters: { hosts: [], workspace: null, extensions: {} } },
                sourceEnumerations: [{ evidence: enumeration, revisionSequence: 1, title: "Plan_37 live fallback fixture" }],
                recordIndex: { scopes: [scope], entries: [entry] },
            };
        };
        const productionSourceReader = {
            async scan(request: { host: "codex"; conversationId: string }) {
                assert.equal(request.host, source.host);
                assert.equal(request.conversationId, source.identity.conversationId);
                const document = {
                    schemaVersion: "record-source-content/v1" as const,
                    formatterVersion: "canonical-json-nfc-lf/v1" as const,
                    source: { host: source.host, conversationId: source.identity.conversationId },
                    messages: [
                        { order: 1, role: "user" as const, content: "Plan_37 live fallback acceptance fixture" },
                        { order: 2, role: "assistant" as const, content: "The scheduler must retain one Unit across Grok to agy fallback." },
                    ],
                };
                const bytes = Buffer.from(JSON.stringify(document), "utf8");
                const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
                const enumeration = buildSourceEnumerationEvidence({
                    adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
                    host: source.host,
                    identity: source.identity,
                    sourceRevision: { revision: "plan-37-revision", contentCursor: "plan-37-cursor", eventWatermark: "plan-37-event", sequence: 1 },
                    pagination: { cursor: null, pages: 1, limit: null, truncated: false },
                    enumerationComplete: true,
                    cacheBypassed: true,
                    exactFetchResult: "present",
                    errors: [],
                    warnings: [],
                    observedAt: { scanId: "plan-37-live-fallback-scan", sequence: 1, startedAt: observedAt, completedAt: observedAt },
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
                const fullSourceRead = buildFullSourceReadEvidence({
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
                        evidence: fullSourceRead,
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
                            revisionHash: createHash("sha256").update(enumeration.sourceRevision.revision).digest("hex"),
                            identityStable: true,
                            revisionStable: true,
                            cacheBypassed: true,
                            enumerationEvidenceHash: enumeration.evidenceHash,
                            exactFetchEvidenceHash: exactFetch.evidenceHash,
                            fullReadEvidenceHash: fullSourceRead.evidenceHash,
                        },
                        issues: [],
                    },
                    sourceSnapshot: null,
                    classification: { state: "Present" as const, reason: "plan-37-live-fallback-fixture" },
                    qualifiedAbsence: null,
                };
            },
        };

        const spool = createRecordSchedulerSpool({ dataRoot });
        const control = createRecordSchedulerControl({ dataRoot, spool });
        const schedulerOwnerId = `record-scheduler-live-fallback-owner-${process.pid}`;
        const taskIdGate = deferred<string>();
        const executionResult = deferred<LiveFallbackResult>();
        const runtime = createRecordSchedulerRuntime({
            mode: "enforced",
            ownerId: schedulerOwnerId,
            control,
            sourceEvidenceAdapter: { buildDiscoveryInput: async () => discoveryInput() as never },
            productionSourceReader: productionSourceReader as never,
        });

        const admitted = await runtime.admit({
            kind: "record-update",
            requestKey: recordSchedulerRequestKey("record-update", {
                operation: "record-update",
                workspaceHash: "plan-37-live-fallback",
                dataChain: "codex",
                modelChain: "auto",
            }),
            requestSummary: {
                operation: "record-update",
                workspaceHash: "plan-37-live-fallback",
                dataChain: "codex",
                modelChain: "auto",
            },
            resumePayload: {
                kind: "record-update",
                workspace: "plan-37-live-fallback",
                modelChain: "auto",
            },
            requestMode: "normal",
            discovery: { kind: "record-update", selector: "normal", input: discoveryInput() as never },
            execute: async (_context, _snapshot, frozenSources) => {
                try {
                    const taskId = await taskIdGate.promise;
                    assert.equal(frozenSources?.phase, "sealed", "production runtime must seal the source fixture before model dispatch");
                    assert.equal(frozenSources?.sources.length, 1, "live fallback fixture must materialize exactly one source");
                    const sourceSet = frozenSources as FrozenRuntimeSourceSet;
                    const selectedSource = sourceSet.sources[0]!;
                    const registration: RecordSchedulerProductionRegistration = {
                        taskId,
                        frozenSources: sourceSet,
                        sourceSnapshotId: selectedSource.snapshot.sourceSnapshotId,
                        recordStoreHash: selectedSource.snapshot.workspaceHash,
                        schedulerOwner: {
                            ownerId: schedulerOwnerId,
                            leaseMs: 120_000,
                            workLeaseMs: 120_000,
                        },
                        control,
                        spool,
                        firstPublicationToken: "record-scheduler-live-fallback-first-publication",
                    };
                    const session = createRecordSchedulerProductionSession(registration, {
                        coordinatorOwnerId: `record-scheduler-live-fallback-coordinator-${process.pid}`,
                        coordinatorLeaseMs: 60_000,
                        coordinatorStore: { dataRoot },
                        providerTransport: transport,
                    });
                    const modelResult = await session.schedulerModelCall(buildRouteCall(
                        `Return exactly ${LIVE_FALLBACK_SENTINEL} and nothing else.`,
                        callModelResponse,
                    ));
                    assert.ok(modelResult.text, `agy fallback returned no model text: ${modelResult.error || modelResult.failureClass || "unknown error"}`);
                    assert.equal(modelResult.chainUsed, "agy", "the successful provider must be agy fallback");
                    assert.equal(modelResult.text.trim(), LIVE_FALLBACK_SENTINEL, "agy fallback must return the exact live sentinel without explanatory text");

                    const expectedBody = `# Plan_37 live fallback\n\n${LIVE_FALLBACK_SENTINEL}`;

                    const finalized = await session.finalizeLocalRecord({
                        content: expectedBody,
                        commit: { firstPublicationToken: registration.firstPublicationToken },
                    });
                    assert.equal(finalized.kind, "verified", "live fallback must complete the real local-finalize commit");
                    const committedBody = await readRecordCommitBodyArtifact(selectedSource.snapshot.workspaceHash, {
                        kind: "record_body",
                        conversationId: source.identity.conversationId,
                        recordId: source.identity.conversationId,
                        relativePath: getRecordCommitArtifactRelativePath("record_body", source.identity.conversationId),
                    });
                    assert.equal(committedBody.body, expectedBody, "verified local-finalize readback must contain only the expected sentinel body");
                    assert.equal(committedBody.ownerCommitId, finalized.commitId, "body readback must be owned by the verified commit");

                    const ledgerRead = await readRecordSchedulerLedgerStore(taskId, { expectPublished: true });
                    if (ledgerRead.kind !== "current") throw new Error(`production scheduler ledger unavailable: ${ledgerRead.kind}`);

                    const providerUnits = ledgerRead.ledger.units.filter(unit => unit.layer === "provider-attempt");
                    assert.equal(providerUnits.length, 1, "grok to agy fallback must retain exactly one provider-attempt root Unit");
                    const providerUnit = providerUnits[0]!;
                    assert.deepEqual(providerUnit.routePlan, ["grok", "agy"]);
                    assert.equal(providerUnit.retryBudget, 0);
                    assert.deepEqual(providerUnit.attemptedProviders, ["grok", "agy"]);
                    assert.equal(providerUnit.routeCursor, 1);
                    assert.equal(providerUnit.unitAttempts, 2);
                    assert.deepEqual(providerUnit.providerAttemptCounts, { grok: 1, agy: 1 });

                    const attempts = ledgerRead.ledger.attempts
                        .filter(attempt => attempt.unitId === providerUnit.unitId)
                        .sort((left, right) => left.attemptId.localeCompare(right.attemptId));
                    assert.equal(attempts.length, 2, "the shared root Unit must contain exactly two provider Attempts");
                    assert.ok(attempts.every(attempt => attempt.unitId === providerUnit.unitId), "both Attempts must retain the same root Unit id");
                    assert.deepEqual(attempts.map(attempt => attempt.provider), ["grok", "agy"]);
                    assert.deepEqual(attempts.map(attempt => attempt.state), ["KnownFailure", "KnownSuccess"]);
                    assert.deepEqual(attempts.map(attempt => attempt.trafficClass), ["record", "agy-fallback"]);
                    assert.deepEqual(attempts.map(attempt => attempt.retryOrdinal), [0, 0]);
                    assert.equal(attempts[0]!.errorClass, "Availability", "dead Grok proxy must become an Availability failure");
                    const transportDiagnostics = transport.diagnostics();
                    assert.equal(transportDiagnostics.mode, "enforced");
                    assert.equal(transportDiagnostics.attempts.length, 2, "enforced transport must observe exactly the Grok and agy Attempts");
                    assert.equal(transportDiagnostics.settleCount, 2, "both live provider permits must settle");
                    assert.equal(transportDiagnostics.settleFailureCount, 0, "live provider permit settlement must not fail");
                    assert.deepEqual(transportDiagnostics.attempts.map(attempt => attempt.provider), ["grok", "agy"]);
                    assert.deepEqual(transportDiagnostics.attempts.map(attempt => attempt.trafficClass), ["record", "agy-fallback"]);
                    assert.deepEqual(transportDiagnostics.attempts.map(attempt => attempt.settlement), ["availability", "success"]);

                    executionResult.resolve({
                        taskId,
                        ledgerPath: ledgerRead.path,
                        commitId: finalized.commitId,
                        attempts: attempts.map(attempt => ({
                            attemptId: attempt.attemptId,
                            unitId: attempt.unitId,
                            provider: attempt.provider,
                            state: attempt.state,
                            failureClass: attempt.errorClass,
                            trafficClass: attempt.trafficClass,
                        })),
                    });
                    return "Plan_37 live provider fallback accepted";
                } catch (error) {
                    executionResult.reject(error);
                    throw error;
                }
            },
        });
        if (admitted.outcome === "UnknownOutcome") throw new Error(`live fallback admission unresolved: ${admitted.reasons.join("; ")}`);

        taskIdGate.resolve(admitted.taskId);
        const result = await executionResult.promise;
        await runtime.waitForTerminal(admitted.taskId, 240);
        console.log(JSON.stringify({ kind: "record-scheduler-live-fallback", ...result }, null, 2));
    } finally {
        await closeRecordSchedulerProductionSessions?.({ timeoutMs: 10_000 });
        if (providerAdapterConfigured) await resetProviderTransportAdapterForTest?.();
        restoreEnvironment("MEMORY_STORE_GROK_PROXY_URL", originalGrokProxyUrl);
        restoreEnvironment("MEMORY_STORE_DATA_ROOT", originalDataRoot);
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
}

await main().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
