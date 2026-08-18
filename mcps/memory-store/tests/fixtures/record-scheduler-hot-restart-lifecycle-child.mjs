import crypto from "node:crypto";

const [action, encodedContext = "{}"] = process.argv.slice(2);
const context = JSON.parse(encodedContext);

if (!action) throw new Error("lifecycle child requires an action");
if (!process.env.MEMORY_STORE_DATA_ROOT) throw new Error("lifecycle child requires MEMORY_STORE_DATA_ROOT");

const dataRoot = process.env.MEMORY_STORE_DATA_ROOT;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, message, attempts = 300) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (predicate()) return;
        await sleep(10);
    }
    throw new Error(message);
}

function deferred() {
    let resolve;
    const promise = new Promise(resolvePromise => {
        resolve = resolvePromise;
    });
    return { promise, resolve };
}

async function buildFrozenTask() {
    const [
        discoveryModule,
        evidenceModule,
        runtimeModule,
        controlModule,
        spoolModule,
    ] = await Promise.all([
        import("../../src/record-discovery.ts"),
        import("../../src/source-evidence-contracts.ts"),
        import("../../src/record-scheduler-runtime.ts"),
        import("../../src/record-scheduler-control.ts"),
        import("../../src/record-scheduler-spool.ts"),
    ]);

    const source = {
        host: "codex",
        identity: {
            workspace: { workspaceId: "lifecycle-hot-restart", canonicalPath: "C:/fixtures/lifecycle-hot-restart" },
            source: {
                kind: "filesystem",
                authority: "C:/fixtures/lifecycle-hot-restart/authority",
                authoritativeRoot: "C:/fixtures/lifecycle-hot-restart/authority",
                canonicalPath: "C:/fixtures/lifecycle-hot-restart/store",
            },
            conversationId: "lifecycle-hot-restart-conversation",
        },
    };
    const observedAt = "2026-07-14T00:00:00.000Z";
    const enumeration = evidenceModule.buildSourceEnumerationEvidence({
        adapterVersion: evidenceModule.SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: source.host,
        identity: source.identity,
        sourceRevision: { revision: "revision-2", contentCursor: "cursor-2", eventWatermark: "event-2", sequence: 2 },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: { scanId: "lifecycle-hot-restart-scan", sequence: 2, startedAt: observedAt, completedAt: observedAt },
        targetStatus: "present",
    });
    const exactFetch = evidenceModule.buildExactFetchEvidence({
        adapterVersion: evidenceModule.SOURCE_EVIDENCE_ADAPTER_VERSION,
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
    const scope = discoveryModule.buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: "lifecycle-hot-restart-index",
        indexRevision: "index-revision-1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
    const indexEntry = discoveryModule.buildRecordIndexEntry({
        recordId: "record-lifecycle-hot-restart-conversation",
        source,
        indexSnapshotId: scope.snapshotId,
        indexRevision: scope.indexRevision,
        coveredRevision: { revision: "revision-1", sequence: 1 },
        recordBodyHash: `sha256:${crypto.createHash("sha256").update("lifecycle-hot-restart").digest("hex")}`,
        extensions: {},
    });
    const discoveryInput = {
        request: { snapshotId: "lifecycle-hot-restart-snapshot", discoveredAtSequence: 2, filters: { hosts: [], workspace: null, extensions: {} } },
        sourceEnumerations: [{ evidence: enumeration, revisionSequence: 2, title: source.identity.conversationId }],
        recordIndex: { scopes: [scope], entries: [indexEntry] },
    };
    const sourceDocument = {
        schemaVersion: "record-source-content/v1",
        formatterVersion: "canonical-json-nfc-lf/v1",
        source: { host: source.host, conversationId: source.identity.conversationId },
        messages: [
            { order: 1, role: "user", content: "lifecycle fixture source" },
            { order: 2, role: "assistant", content: "lifecycle fixture response" },
        ],
    };
    const sourceBytes = Buffer.from(JSON.stringify(sourceDocument), "utf8");
    const contentHash = `sha256:${crypto.createHash("sha256").update(sourceBytes).digest("hex")}`;
    const fullEvidence = evidenceModule.buildFullSourceReadEvidence({
        adapterVersion: evidenceModule.SOURCE_EVIDENCE_ADAPTER_VERSION,
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
        content: { mode: "full", byteLength: sourceBytes.byteLength, contentHash, roundRange: { start: 1, end: 2 }, truncated: false, staleCache: false },
    });
    const productionSourceReader = {
        async scan(request) {
            if (request.host !== source.host || request.conversationId !== source.identity.conversationId) {
                throw new Error("unexpected lifecycle fixture source read");
            }
            return {
                host: source.host,
                scanId: enumeration.observedAt.scanId,
                enumeration,
                exactFetch,
                fullSourceRead: {
                    status: "complete",
                    evidence: fullEvidence,
                    payload: {
                        schemaVersion: sourceDocument.schemaVersion,
                        formatterVersion: sourceDocument.formatterVersion,
                        mediaType: "application/vnd.memory-store.record-source+json",
                        encoding: "utf-8",
                        bytes: sourceBytes,
                        byteLength: sourceBytes.byteLength,
                        contentHash,
                    },
                    sourceSnapshot: null,
                    authority: {
                        identityHash: crypto.createHash("sha256").update(JSON.stringify(source.identity)).digest("hex"),
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
                classification: { state: "Present", reason: "lifecycle-hot-restart-fixture" },
                qualifiedAbsence: null,
            };
        },
    };
    const spool = spoolModule.createRecordSchedulerSpool({
        dataRoot,
        proofVerifier: controlModule.createLedgerBackedSpoolProofVerifier(),
    });
    const control = controlModule.createRecordSchedulerControl({ dataRoot, spool });
    const hold = deferred();
    let captured;
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: "lifecycle-hot-restart-runtime-owner",
        ownerLeaseMs: 1_000,
        control,
        sourceEvidenceAdapter: { buildDiscoveryInput: async () => discoveryInput },
        productionSourceReader,
        executeForTest: async request => {
            captured = request;
            await hold.promise;
            return "lifecycle fixture should be terminated before generic execution resolves";
        },
    });
    const requestSummary = {
        operation: "record-update",
        workspaceHash: "lifecycle-hot-restart-workspace",
        dataChain: "codex",
        modelChain: "grok",
    };
    const admission = await runtime.admit({
        kind: "record-update",
        requestKey: runtimeModule.recordSchedulerRequestKey("record-update", requestSummary),
        requestSummary,
        resumePayload: { kind: "record-update", workspace: dataRoot },
        requestMode: "normal",
        discovery: { kind: "record-update", selector: "normal", input: discoveryInput },
        execute: async () => "production executor must not run in lifecycle fixture",
    });
    if (admission.outcome !== "Admitted") throw new Error(`lifecycle fixture admission failed: ${JSON.stringify(admission)}`);
    await waitFor(() => captured !== undefined, "lifecycle fixture did not freeze source snapshots");
    return { taskId: admission.taskId, frozenSources: captured.sourceSnapshots, control, spool, hold };
}

async function holdForSignal() {
    const fixture = await buildFrozenTask();
    const pumpModule = await import("../../src/record-scheduler-production-pump.ts");
    const pump = pumpModule.getRecordSchedulerProductionPump({
        coordinatorOwnerId: "lifecycle-hot-restart-coordinator",
        coordinatorLeaseMs: 5_000,
        coordinatorStore: { dataRoot },
    });
    const session = pump.createSession({
        taskId: "lifecycle-hot-restart-route-probe",
        frozenSources: fixture.frozenSources,
        sourceSnapshotId: fixture.frozenSources.sources[0].snapshot.sourceSnapshotId,
        recordStoreHash: fixture.frozenSources.sources[0].snapshot.workspaceHash,
        schedulerOwner: { ownerId: "lifecycle-hot-restart-runtime-owner", leaseMs: 1_000, workLeaseMs: 1_000 },
        control: fixture.control,
        spool: fixture.spool,
        firstPublicationToken: "lifecycle-hot-restart-first-publication",
    });
    const invoke = async () => ({ text: "route probe must not dispatch" });
    let routeContractAccepted = false;
    try {
        await session.schedulerModelCall({
            logicalCallKey: "lifecycle-hot-restart-invoking",
            provider: "grok",
            model: "fake-lifecycle-grok",
            prompt: "lifecycle hot restart fixture",
            logicalTimeout: 1_000,
            invokeTimeout: 1_000,
            retryOrdinal: 0,
            routePlan: ["grok"],
            providerCalls: [{
                provider: "grok",
                model: "fake-lifecycle-grok",
                logicalTimeout: 1_000,
                invokeTimeout: 1_000,
                invoke,
                invokePrompt: async (_prompt, options) => await invoke(options),
            }],
            recipe: {
                recipeVersion: 1,
                templateId: "lifecycle-hot-restart-fixture",
                range: { axis: "round", start: 1, end: 2 },
                composeOrder: 0,
            },
            retryBudget: 0,
            splitPrompt: range => `lifecycle hot restart fixture rounds ${range.start}-${range.end}`,
            trafficClass: "record-batch",
            context: { requestedChain: "grok", background: true, providerTrafficClass: "record", grokContext: "record" },
            invoke,
        });
    } catch (error) {
        if (error instanceof TypeError) throw new Error(`lifecycle route contract rejected: ${error.message}`);
        if (!/无法读取 scheduler ledger lifecycle-hot-restart-route-probe: (?:missing|repair_required)/u.test(error instanceof Error ? error.message : String(error))) {
            throw error;
        }
        routeContractAccepted = true;
    }
    if (!routeContractAccepted) throw new Error("lifecycle route probe unexpectedly dispatched against a missing ledger");

    const schedulerStore = await import("../../src/record-scheduler-store.ts");
    const persisted = await schedulerStore.readRecordSchedulerLedgerStore(fixture.taskId, { expectPublished: true });
    if (persisted.kind !== "current" || !persisted.ledger.schedulerOwner) {
        throw new Error("lifecycle fixture did not persist a scheduler owner lease");
    }
    process.stdout.write(`${JSON.stringify({
        type: "ready",
        taskId: fixture.taskId,
        oldOwnerLease: persisted.ledger.schedulerOwner,
        oldOwnerEpoch: persisted.ledger.schedulerOwner.schedulerEpoch,
        routeContractAccepted,
    })}\n`);
    setInterval(() => undefined, 1_000);

}

async function recoverFromDisk() {
    if (typeof context.taskId !== "string" || !context.oldOwnerLease) {
        throw new Error("recovery child requires taskId and oldOwnerLease");
    }
    const [backgroundTasks, runtimeModule, controlModule, spoolModule, schedulerStore] = await Promise.all([
        import("../../src/background-tasks.ts"),
        import("../../src/record-scheduler-runtime.ts"),
        import("../../src/record-scheduler-control.ts"),
        import("../../src/record-scheduler-spool.ts"),
        import("../../src/record-scheduler-store.ts"),
    ]);
    const spool = spoolModule.createRecordSchedulerSpool({
        dataRoot,
        proofVerifier: controlModule.createLedgerBackedSpoolProofVerifier(),
    });
    const control = controlModule.createRecordSchedulerControl({ dataRoot, spool });
    const runtime = runtimeModule.createRecordSchedulerRuntime({
        mode: "test",
        ownerId: "lifecycle-hot-restart-recovery-owner",
        ownerLeaseMs: 1_000,
        control,
        executeForTest: async () => "lifecycle recovery executor must not run",
    });
    let handlerCalls = 0;
    let runCalls = 0;
    backgroundTasks.registerBackgroundTaskRecoveryHandler("record-update", task => {
        if (task.id !== context.taskId) return undefined;
        handlerCalls += 1;
        return {
            mode: "resume",
            run: async () => {
                runCalls += 1;
                let recoveryReason = "unknown recovery result";
                let recovery;
                for (let attempt = 0; attempt < 600; attempt += 1) {
                    recovery = await runtime.recover(context.taskId);
                    if (recovery?.kind === "recovered") break;
                    if (recovery?.kind === "repair_required" || recovery?.kind === "missing") {
                        throw new Error(`recovery child cannot take ownership: ${recovery.reason}`);
                    }
                    recoveryReason = recovery?.reason || "runtime returned no recovery result";
                    await sleep(20);
                }
                if (recovery?.kind !== "recovered") throw new Error(`recovery child timed out waiting to claim scheduler owner: ${recoveryReason}`);
                const terminal = await control.cancel(context.taskId);
                if (terminal.disposition !== "cancelled") throw new Error(`recovery child did not terminally cancel task: ${terminal.disposition}; ${terminal.reason || "no reason"}`);
                return `lifecycle-recovered:${recovery.ownerLease.schedulerEpoch}`;
            },
        };
    });
    try {
        const startup = await backgroundTasks.runBackgroundTaskStartupRecovery();
        const watched = startup.recordScheduler.results.find(result => result.taskId === context.taskId);
        const controlTask = backgroundTasks.getBackgroundTask(context.taskId);
        process.stdout.write(`${JSON.stringify({
            type: "watching",
            taskId: context.taskId,
            startupOutcome: watched?.outcome || null,
            startupReason: watched?.reason || null,
            controlTaskId: controlTask?.id || null,
            controlStatus: controlTask?.status || null,
            watchTaskIds: backgroundTasks.__testRecordSchedulerRecoveryWatchTaskIds(),
            handlerCalls,
            runCalls,
        })}\n`);

        try {
            await waitFor(() => {
                const status = backgroundTasks.getBackgroundTask(context.taskId)?.status;
                return status === "done" || status === "error";
            }, "recovery child watcher did not settle the recovered task", 1_200);
        } catch (error) {
            throw new Error(`${error.message}; control=${JSON.stringify(backgroundTasks.getBackgroundTask(context.taskId))}`);
        }
        const settledControlTask = backgroundTasks.getBackgroundTask(context.taskId);
        if (settledControlTask?.status !== "done") {
            throw new Error(`recovery child watcher settled unexpectedly: ${JSON.stringify(settledControlTask)}`);
        }
        let staleMutatorRan = false;
        let staleRejected = false;
        const persisted = await schedulerStore.readRecordSchedulerLedgerStore(context.taskId, { expectPublished: true });
        if (persisted.kind === "current") {
            await schedulerStore.mutateRecordSchedulerLedgerAsOwner(
                context.taskId,
                persisted.ledger.revision,
                context.oldOwnerLease,
                () => {
                    staleMutatorRan = true;
                    throw new Error("stale owner reached a mutation callback");
                },
            ).catch(() => {
                staleRejected = true;
            });
        }
        process.stdout.write(`${JSON.stringify({
            type: "recovered",
            taskId: context.taskId,
            persistedKind: persisted.kind,
            taskState: persisted.kind === "current" ? persisted.ledger.task.state : null,
            recoveryOwnerId: persisted.kind === "current" ? persisted.ledger.schedulerOwner?.ownerId || null : null,
            recoveryEpoch: persisted.kind === "current" ? persisted.ledger.schedulerOwner?.schedulerEpoch || null : null,
            controlStatus: backgroundTasks.getBackgroundTask(context.taskId)?.status || null,
            watchTaskIds: backgroundTasks.__testRecordSchedulerRecoveryWatchTaskIds(),
            handlerCalls,
            runCalls,
            staleRejected,
            staleMutatorRan,
        })}\n`);
    } finally {
        backgroundTasks.unregisterBackgroundTaskRecoveryHandler("record-update");
    }
}

if (action === "hold") {
    await holdForSignal();
} else if (action === "recover") {
    await recoverFromDisk();
} else {
    throw new Error(`unknown lifecycle child action: ${action}`);
}
