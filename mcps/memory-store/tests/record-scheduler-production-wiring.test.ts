import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConversationLoadResult } from "../src/conversation-bridge.ts";
import type { ConversationRound } from "../src/trajectory.ts";
import {
    buildRecordIndexEntry,
    buildRecordIndexScope,
    discoverRecordCandidates,
    type RecordSourceIdentity,
} from "../src/record-discovery.ts";
import {
    SOURCE_EVIDENCE_ADAPTER_VERSION,
    buildExactFetchEvidence,
    buildFullSourceReadEvidence,
    buildLostObservation,
    buildSourceEnumerationEvidence,
    canonicalSerialize,
    type SourceEvidenceHost,
} from "../src/source-evidence-contracts.ts";

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mstore-record-scheduler-wiring-"));
process.env.MEMORY_STORE_DATA_ROOT = dataRoot;
process.env.MEMORY_STORE_AUTO_RECORD = "0";

const {
    __setRecordSchedulerRuntimeForTest,
    createRecordSchedulerRuntime,
    recordSchedulerRequestKey,
} = await import("../src/record-scheduler-runtime.ts");
const {
    listRecordSchedulerLedgerTaskIds,
    readRecordSchedulerLedgerStoreSync,
    recordSchedulerLedgerPath,
    setRecordSchedulerStoreFaultInjectorForTest,
} = await import("../src/record-scheduler-store.ts");
const { workspaceHash } = await import("../src/store.ts");
const { __recordConcurrencyTest, registerRecord } = await import("../src/tools/record.ts");
const { registerBackgroundTask } = await import("../src/tools/background-task.ts");
const {
    __testEvictFromMemory,
    getBackgroundTask,
    getBackgroundTaskQueueStatsForTest,
} = await import("../src/background-tasks.ts");
const sourceCache = await import("../src/conversation-source-cache.ts");
sourceCache.resetConversationSourceCacheForTests();
sourceCache.setConversationSourceCacheDataRootForTests(dataRoot);

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: "text"; text: string }> }>;

const handlers = new Map<string, ToolHandler>();
const fakeServer = {
    tool(name: string, _description: string, _schema: unknown, handler: ToolHandler) {
        handlers.set(name, handler);
    },
};

function responseText(response: { content: Array<{ type: "text"; text: string }> }): string {
    return response.content.map(item => item.text).join("\n");
}

function taskIdFrom(text: string): string {
    const match = text.match(/taskId:\s*([^\s]+)/u);
    assert.ok(match, `missing scheduler taskId: ${text}`);
    return match[1];
}

function currentSchedulerLedger(taskId: string) {
    const stored = readRecordSchedulerLedgerStoreSync(taskId, { expectPublished: true });
    assert.equal(stored.kind, "current", `expected current scheduler ledger for ${taskId}`);
    if (stored.kind !== "current") throw new Error(`scheduler ledger ${taskId} is ${stored.kind}`);
    return stored.ledger;
}

function batchResumeIdentity(workspace: string, limit: number) {
    const request = { limit, workspace };
    const requestSummary = {
        operation: "record-batch-update",
        actionName: "batch_update",
        workspaceHash: workspaceHash(workspace),
        dataChain: "codex",
        modelChain: "codex",
        force: false,
        staleOnly: false,
        request,
    };
    const requestKey = recordSchedulerRequestKey("record-batch-update", requestSummary);
    const resumeKey = `scheduler-${requestKey.slice("record-batch-update:".length)}`;
    return {
        resumeKey,
        ledgerPath: path.join(dataRoot, "record-task-recovery", `record-batch-${resumeKey}.json`),
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const fixtureTimeMs = Date.parse("2026-07-13T00:00:00.000Z");

function fixtureHash(value: unknown): string {
    return `sha256:${createHash("sha256").update(canonicalSerialize(value)).digest("hex")}`;
}

function fixtureSource(host: SourceEvidenceHost, workspace: string, conversationId: string): RecordSourceIdentity {
    return {
        host,
        identity: {
            workspace: { workspaceId: workspace, canonicalPath: workspace },
            source: {
                kind: "filesystem",
                authority: `${workspace}/authority`,
                authoritativeRoot: `${workspace}/authority`,
                canonicalPath: `${workspace}/store`,
            },
            conversationId,
        },
    };
}

function fixtureEnumeration(
    source: RecordSourceIdentity,
    revision: string,
    sequence: number,
    options: { complete?: boolean; cacheBypassed?: boolean; error?: boolean; targetStatus?: "present" | "absent" } = {},
) {
    const completedAt = new Date(fixtureTimeMs + sequence * 1_000).toISOString();
    const evidence = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: source.host,
        identity: source.identity,
        sourceRevision: { revision, contentCursor: `cursor-${revision}`, eventWatermark: `event-${revision}`, sequence },
        pagination: { cursor: options.complete === false ? "next" : null, pages: 1, limit: null, truncated: options.complete === false },
        enumerationComplete: options.complete ?? true,
        cacheBypassed: options.cacheBypassed ?? true,
        exactFetchResult: options.targetStatus === "absent" ? "not_found" : "present",
        errors: options.error ? [{ code: "source_unavailable", message: "fixture source unavailable" }] : [],
        warnings: [],
        observedAt: { scanId: `scan-${source.host}-${source.identity.conversationId}`, sequence, startedAt: completedAt, completedAt },
        targetStatus: options.targetStatus || "present",
    });
    return { evidence, revisionSequence: sequence, title: source.identity.conversationId };
}

function fixtureUnsequencedEnumeration(
    source: RecordSourceIdentity,
    revision: string,
    observedSequence: number,
) {
    const completedAt = new Date(fixtureTimeMs + observedSequence).toISOString();
    const evidence = buildSourceEnumerationEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: source.host,
        identity: source.identity,
        sourceRevision: { revision, contentCursor: `cursor-${revision}`, eventWatermark: `event-${revision}`, sequence: null },
        pagination: { cursor: null, pages: 1, limit: null, truncated: false },
        enumerationComplete: true,
        cacheBypassed: true,
        exactFetchResult: "present",
        errors: [],
        warnings: [],
        observedAt: { scanId: `scan-${source.host}-${source.identity.conversationId}`, sequence: observedSequence, startedAt: completedAt, completedAt },
        targetStatus: "present",
    });
    return { evidence, revisionSequence: null, title: source.identity.conversationId };
}

function fixtureExactFetch(enumeration: ReturnType<typeof fixtureEnumeration>) {
    return buildExactFetchEvidence({
        adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
        host: enumeration.evidence.host,
        identity: enumeration.evidence.identity,
        sourceRevision: enumeration.evidence.sourceRevision,
        pagination: enumeration.evidence.pagination,
        enumerationComplete: enumeration.evidence.enumerationComplete,
        cacheBypassed: enumeration.evidence.cacheBypassed,
        exactFetchResult: enumeration.evidence.targetStatus === "absent" ? "not_found" : "present",
        errors: enumeration.evidence.errors,
        warnings: enumeration.evidence.warnings,
        observedAt: enumeration.evidence.observedAt,
    });
}

function fixtureScope(source: RecordSourceIdentity) {
    return buildRecordIndexScope({
        workspace: source.identity.workspace,
        snapshotId: `index-${source.host}-${source.identity.conversationId}`,
        indexRevision: "index-rev-1",
        complete: true,
        paginationComplete: true,
        error: null,
        extensions: {},
    });
}

function fixtureEntry(source: RecordSourceIdentity, coveredRevision: string | null) {
    return buildRecordIndexEntry({
        recordId: `record-${source.host}-${source.identity.conversationId}`,
        source,
        indexSnapshotId: `index-${source.host}-${source.identity.conversationId}`,
        indexRevision: "index-rev-1",
        coveredRevision: coveredRevision ? { revision: coveredRevision, sequence: 1 } : null,
        recordBodyHash: fixtureHash({ source, coveredRevision }),
        extensions: {},
    });
}

const sharedStaleSource = fixtureSource("codex", "C:/fixtures/shared", "shared-stale");
const sharedDiscoveryInput = {
    request: { snapshotId: "shared-handler-snapshot", discoveredAtSequence: 10, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [fixtureEnumeration(sharedStaleSource, "rev-2", 2)],
    recordIndex: { scopes: [fixtureScope(sharedStaleSource)], entries: [fixtureEntry(sharedStaleSource, "rev-1")] },
};
const sharedFrozenWorkspace = discoverRecordCandidates(sharedDiscoveryInput).candidates[0]?.source.identity.workspace.canonicalPath;
assert.ok(sharedFrozenWorkspace, "shared scheduler fixture must expose a canonical workspace");
const unresolvedHosts = ["codex", "claude-code", "windsurf", "antigravity"] as const;
const unresolvedSources = unresolvedHosts.map(host => fixtureSource(host, `C:/fixtures/${host}`, `partial-${host}`));
const unresolvedSnapshot = discoverRecordCandidates({
    request: { snapshotId: "four-host-unresolved", discoveredAtSequence: 20, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: unresolvedSources.map((source, index) => fixtureEnumeration(source, `rev-${index + 1}`, index + 1, {
        complete: false,
        cacheBypassed: false,
        error: true,
    })),
    recordIndex: { scopes: unresolvedSources.map(fixtureScope), entries: unresolvedSources.map(source => fixtureEntry(source, "rev-0")) },
});
assert.deepEqual(
    unresolvedSnapshot.candidates.map(candidate => candidate.classification),
    ["Unresolved", "Unresolved", "Unresolved", "Unresolved"],
    "partial/cache/error evidence from every host must remain Unresolved",
);

const lostSource = fixtureSource("windsurf", "C:/fixtures/lost", "lost-conversation");
const lostEnumeration = fixtureEnumeration(lostSource, "gone", 30, { targetStatus: "absent" });
const lostExactFetch = buildExactFetchEvidence({
    adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
    host: lostSource.host,
    identity: lostSource.identity,
    sourceRevision: lostEnumeration.evidence.sourceRevision,
    pagination: lostEnumeration.evidence.pagination,
    enumerationComplete: true,
    cacheBypassed: true,
    exactFetchResult: "not_found",
    errors: [],
    warnings: [],
    observedAt: lostEnumeration.evidence.observedAt,
});
const lostSnapshot = discoverRecordCandidates({
    request: { snapshotId: "lost-host", discoveredAtSequence: 30, filters: { hosts: [], workspace: null, extensions: {} } },
    sourceEnumerations: [lostEnumeration],
    recordIndex: { scopes: [fixtureScope(lostSource)], entries: [fixtureEntry(lostSource, "rev-1")] },
    absenceObservations: [{
        confirmation: "stable_exact_not_found",
        evidence: buildLostObservation({ enumeration: lostEnumeration.evidence, exactFetch: lostExactFetch }),
        observedAtMs: Date.parse(lostEnumeration.evidence.observedAt.completedAt),
    }],
});
assert.equal(lostSnapshot.candidates[0]?.classification, "Lost", "stable full absence evidence should classify only as Lost");

const testProductionSourceReader = {
    async scan(request: { host: SourceEvidenceHost; conversationId: string; workspace: { workspaceId: string; canonicalPath: string | null } }) {
        assert.equal(request.host, sharedStaleSource.host);
        assert.equal(request.conversationId, sharedStaleSource.identity.conversationId);
        assert.equal(request.workspace.workspaceId, sharedStaleSource.identity.workspace.workspaceId);
        const source = sharedStaleSource;
        const enumerationRecord = fixtureEnumeration(source, "rev-2", 2);
        const enumeration = enumerationRecord.evidence;
        const exactFetch = fixtureExactFetch(enumerationRecord);
        const document = {
            schemaVersion: "record-source-content/v1" as const,
            formatterVersion: "canonical-json-nfc-lf/v1" as const,
            source: { host: request.host, conversationId: request.conversationId },
            messages: [
                { order: 1, role: "user" as const, content: "fixture source request" },
                { order: 2, role: "assistant" as const, content: "fixture source response" },
            ],
        };
        const bytes = Buffer.from(JSON.stringify(document), "utf8");
        const contentHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
        const fullEvidence = buildFullSourceReadEvidence({
            adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
            host: request.host,
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
            host: request.host,
            scanId: enumeration.observedAt.scanId,
            enumeration,
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
            classification: { state: "Present" as const, reason: "offline-production-wiring-reader" },
            qualifiedAbsence: null,
        };
    },
};

let fakeExecutions = 0;
let releaseBlocked: (() => void) | undefined;
let releaseMissingLedger: (() => void) | undefined;
const discoveryCalls: Array<{ kind: string; selector: string; requestKey?: string }> = [];
const testRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-production-wiring-test",
    executeForTest: async request => {
        fakeExecutions += 1;
        if (request.requestSummary.conversationId === "cancelled-conversation") {
            await new Promise<void>(resolve => { releaseBlocked = resolve; });
        }
        if (request.requestSummary.conversationId === "missing-ledger-cancel") {
            await new Promise<void>(resolve => { releaseMissingLedger = resolve; });
        }
        return `fake scheduler execution: ${request.kind}`;
    },
    sourceEvidenceAdapter: {
        buildDiscoveryInput: async request => {
            discoveryCalls.push({ kind: request.kind, selector: request.selector, requestKey: request.requestKey });
            return sharedDiscoveryInput as never;
        },
    },
    productionSourceReader: testProductionSourceReader as never,
});

__setRecordSchedulerRuntimeForTest(testRuntime);
registerRecord(fakeServer as never);
registerBackgroundTask(fakeServer as never);

const rawRecordManage = handlers.get("record_manage");
const backgroundStatus = handlers.get("background_task_status");
const backgroundCancel = handlers.get("background_task_cancel");
assert.ok(rawRecordManage, "record_manage handler should be registered");
assert.ok(backgroundStatus, "background_task_status handler should be registered");
assert.ok(backgroundCancel, "background_task_cancel handler should be registered");

const publishedFixtureCaches = new Set<string>();
async function ensureFixtureConversationCache(conversationId: string): Promise<void> {
    if (publishedFixtureCaches.has(conversationId)) return;
    const round: ConversationRound = {
        roundIndex: 1,
        startStep: 1,
        endStep: 2,
        userMessage: `fixture request ${conversationId}`,
        mediaAttachments: [],
        aiResponses: [{ stepIndex: 2, response: "fixture response", thinking: "", toolCalls: [] }],
        toolCalls: [],
        taskBoundaries: [],
        codeActions: [],
        subagentSummaries: [],
        userMessages: [{ stepIndex: 1, text: `fixture request ${conversationId}`, rawRole: "user", semanticRole: "user", mediaAttachments: [] }],
        legacyRoundIndices: [1],
        semanticEvents: [],
    };
    const snapshot: ConversationLoadResult = {
        chainUsed: "codex",
        conversationId,
        rounds: [],
        roundCount: 1,
        totalSteps: 2,
        sourceRevision: `fixture-authority:${conversationId}`,
        codexData: {
            thread: {
                id: conversationId,
                rolloutPath: path.join(dataRoot, `${conversationId}.jsonl`),
                cwd: dataRoot,
                title: conversationId,
                source: "fixture",
            },
            rounds: [],
            totalSteps: 2,
            childThreads: [],
        },
    };
    await sourceCache.readOrBuildConversationSourceCache<ConversationLoadResult, ConversationRound>({
        key: { source: "codex:link=summary", conversationId },
        fingerprint: null,
        build: () => ({ snapshot, rounds: [round] }),
        getRoundNumber: item => item.roundIndex,
    });
    publishedFixtureCaches.add(conversationId);
}

const recordManage: ToolHandler = async args => {
    if (args.action === "update" && typeof args.conversationId === "string") {
        await ensureFixtureConversationCache(args.conversationId);
    }
    return rawRecordManage(args);
};

async function startFixtureBatch(workspace: string, limit: number) {
    return recordManage({
        action: "batch_update",
        background: true,
        limit,
        workspace,
        dataChain: "codex",
        modelChain: "codex",
        chain: "codex",
    });
}

const baselineLedgerCount = listRecordSchedulerLedgerTaskIds().length;
const sync = await recordManage({
    action: "update",
    background: false,
    conversationId: "sync-conversation",
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
assert.match(responseText(sync), /(fake scheduler execution: record-update|Record scheduler 任务：Succeeded)/u);
assert.equal(fakeExecutions, 1, "sync update should execute through exactly one scheduler admission");

const background = await recordManage({
    action: "update",
    background: true,
    conversationId: "background-conversation",
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
const backgroundTaskId = taskIdFrom(responseText(background));
await testRuntime.waitForTerminal(backgroundTaskId, 10);
assert.equal(listRecordSchedulerLedgerTaskIds().length, baselineLedgerCount + 2, "sync and background entry should each create one ledger admission");
assert.equal(fakeExecutions, 2, "background update should execute through exactly one scheduler admission");

const strictBoundaryLedgerCount = listRecordSchedulerLedgerTaskIds().length;
await assert.rejects(
    testRuntime.admit({
        kind: "record-update",
        requestKey: " invalid-request-key ",
        requestSummary: { operation: "record-update", conversationId: "invalid-identity", workspaceHash: "invalid", dataChain: "codex" },
        resumePayload: { kind: "record-update", conversationId: "invalid-identity", workspaceHash: "invalid", dataChain: "codex", modelChain: "codex" },
        requestMode: "normal",
        execute: async () => "must not run",
    }),
    /stable admission identity|稳定 admission identity|requestKey/u,
);
assert.equal(
    listRecordSchedulerLedgerTaskIds().length,
    strictBoundaryLedgerCount,
    "schema that cannot form a stable request identity must fail before creating any ledger",
);

const uncertainPersistenceArgs = {
    action: "update",
    background: true,
    conversationId: "unconfirmed-persistence-conversation",
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
};
let injectedUnconfirmedPersistence = false;
setRecordSchedulerStoreFaultInjectorForTest(context => {
    if (!injectedUnconfirmedPersistence && context.operation === "create" && context.point === "after-task-ledger-write") {
        injectedUnconfirmedPersistence = true;
        throw new Error("injected unconfirmed L1 persistence");
    }
});
let unconfirmedPersistence;
try {
    unconfirmedPersistence = await recordManage(uncertainPersistenceArgs);
} finally {
    setRecordSchedulerStoreFaultInjectorForTest();
}
const unconfirmedText = responseText(unconfirmedPersistence);
assert.match(unconfirmedText, /接纳结果未确定.*未返回成功 taskId/us);
assert.doesNotMatch(unconfirmedText, /^🆔 taskId:/mu, "unconfirmed persistence must not expose a successful taskId");
const unconfirmedCandidate = unconfirmedText.match(/候选 ledger:\s*([^\s]+)/u)?.[1];
assert.ok(unconfirmedCandidate, "unconfirmed L1 persistence must enumerate its candidate ledger for retry");
const persistenceReplay = await recordManage(uncertainPersistenceArgs);
const persistenceReplayTaskId = taskIdFrom(responseText(persistenceReplay));
assert.equal(persistenceReplayTaskId, unconfirmedCandidate, "retry must continue the same persisted L1 instead of creating another task");
await testRuntime.waitForTerminal(persistenceReplayTaskId, 10);
assert.equal(testRuntime.status(persistenceReplayTaskId)?.state, "Succeeded");

const sequentialDiscoveryBaseline = discoveryCalls.length;
const stale = await recordManage({ action: "stale_check", workspace: dataRoot, dataChain: "codex", limit: 10 });
assert.match(responseText(stale), /冻结快照 shared-handler-snapshot/u, "stale_check must read the scheduler discovery snapshot");
const batch = await recordManage({
    action: "batch_update",
    background: false,
    stale_only: true,
    limit: 10,
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
assert.match(responseText(batch), /(fake scheduler execution: record-batch-update|Record scheduler 任务：Succeeded)/u);
assert.equal(discoveryCalls.length - sequentialDiscoveryBaseline, 2, "顺序 stale_check 与 batch 必须各自重新 discovery；冻结快照只能由并发 single-flight 共享");
const normalBatch = await recordManage({
    action: "batch_update",
    background: false,
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
assert.match(responseText(normalBatch), /(fake scheduler execution: record-batch-update|Record scheduler 任务：Succeeded)/u);
const forceBatch = await recordManage({
    action: "batch_update",
    background: false,
    force: true,
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
assert.match(responseText(forceBatch), /(fake scheduler execution: record-batch-update|Record scheduler 任务：Succeeded)/u);
assert.deepEqual(
    discoveryCalls.slice(sequentialDiscoveryBaseline).map(call => ({ kind: call.kind, selector: call.selector })),
    [
        { kind: "stale_check", selector: "stale_only" },
        { kind: "record-batch-update", selector: "stale_only" },
        { kind: "record-batch-update", selector: "normal" },
        { kind: "record-batch-update", selector: "force" },
    ],
    "default runtime source adapter must serve stale_check and every batch selector without discover/input injection",
);

const backgroundBatchLedgerCount = listRecordSchedulerLedgerTaskIds().length;
const backgroundBatch = await recordManage({
    action: "batch_update",
    background: true,
    stale_only: true,
    limit: 11,
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
const backgroundBatchTaskId = taskIdFrom(responseText(backgroundBatch));
await testRuntime.waitForTerminal(backgroundBatchTaskId, 10);
assert.equal(listRecordSchedulerLedgerTaskIds().length, backgroundBatchLedgerCount + 1, "background batch must create exactly one scheduler admission");

const recoveryGateReleases: Array<() => void> = [];
const recoveryExecutionKinds: string[] = [];
const recoveryBypassRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-recovery-bypass-fixture",
    executeForTest: async request => {
        recoveryExecutionKinds.push(request.kind);
        await new Promise<void>(resolve => { recoveryGateReleases.push(resolve); });
        return "must not be replaced by legacy recovery";
    },
    sourceEvidenceAdapter: { buildDiscoveryInput: async () => sharedDiscoveryInput as never },
    productionSourceReader: testProductionSourceReader as never,
});
__setRecordSchedulerRuntimeForTest(recoveryBypassRuntime);
try {
    const updateRecoveryEnvelope = await recordManage({
        action: "update",
        background: true,
        conversationId: "recovery-bypass-update",
        workspace: path.join(dataRoot, "recovery-bypass-update"),
        dataChain: "codex",
        modelChain: "codex",
        chain: "codex",
    });
    const updateRecoveryTaskId = taskIdFrom(responseText(updateRecoveryEnvelope));
    while (recoveryExecutionKinds.length < 1) await sleep(10);
    fs.rmSync(recordSchedulerLedgerPath(updateRecoveryTaskId));
    const updateRecovery = await recordManage({ action: "recover", taskId: updateRecoveryTaskId });
    assert.match(responseText(updateRecovery), /admission envelope .*ledger .*拒绝回退旧执行路径/u, "scheduler update envelope with a deleted ledger must be RepairRequired, never legacy-resumed");
    assert.equal(recoveryExecutionKinds.length, 1, "deleted update ledger recovery must not invoke a second scheduler/model or legacy handler execution");

    const batchRecoveryEnvelope = await recordManage({
        action: "batch_update",
        background: true,
        limit: 23,
        workspace: path.join(dataRoot, "recovery-bypass-batch"),
        dataChain: "codex",
        modelChain: "codex",
        chain: "codex",
    });
    const batchRecoveryTaskId = taskIdFrom(responseText(batchRecoveryEnvelope));
    while (recoveryExecutionKinds.length < 2) await sleep(10);
    fs.rmSync(recordSchedulerLedgerPath(batchRecoveryTaskId));
    const batchRecovery = await recordManage({ action: "recover", taskId: batchRecoveryTaskId });
    assert.match(responseText(batchRecovery), /admission envelope .*ledger .*拒绝回退旧执行路径/u, "scheduler batch envelope with a deleted ledger must be RepairRequired, never legacy-resumed");
    assert.equal(recoveryExecutionKinds.length, 2, "deleted batch ledger recovery must not invoke a second scheduler/model or legacy handler execution");
} finally {
    for (const release of recoveryGateReleases) release();
    __setRecordSchedulerRuntimeForTest(testRuntime);
}

let postAdmissionDiscoveryExecutions = 0;
const postAdmissionDiscoveryFailureRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-post-admission-discovery-failure",
    executeForTest: async () => {
        postAdmissionDiscoveryExecutions += 1;
        return "must not execute after discovery failure";
    },
    sourceEvidenceAdapter: { buildDiscoveryInput: async () => undefined as never },
});
__setRecordSchedulerRuntimeForTest(postAdmissionDiscoveryFailureRuntime);
let postAdmissionDiscoveryFailure;
try {
    postAdmissionDiscoveryFailure = await recordManage({
        action: "batch_update",
        background: true,
        limit: 17,
        workspace: path.join(dataRoot, "post-admission-discovery-failure"),
        dataChain: "codex",
        modelChain: "codex",
        chain: "codex",
    });
} finally {
    __setRecordSchedulerRuntimeForTest(testRuntime);
}
const postAdmissionDiscoveryTaskId = taskIdFrom(responseText(postAdmissionDiscoveryFailure));
await postAdmissionDiscoveryFailureRuntime.waitForTerminal(postAdmissionDiscoveryTaskId, 10);
const postAdmissionDiscoveryLedger = currentSchedulerLedger(postAdmissionDiscoveryTaskId);
assert.equal(postAdmissionDiscoveryLedger.task.admission.state, "EnvelopeBound", "discovery must begin only after durable L2 admission");
assert.equal(postAdmissionDiscoveryLedger.task.state, "RepairRequired", "post-admission discovery failure must persist RepairRequired");
assert.equal(postAdmissionDiscoveryExecutions, 0, "discovery failure must stop before fake or legacy execution");
assert.match(
    postAdmissionDiscoveryLedger.candidateSnapshot.enumerations.map(enumeration => enumeration.error || "").join("; "),
    /缺少生产 input|无法冻结候选快照/u,
    "the same ledger must retain the post-admission discovery failure evidence",
);

for (const failure of [
    { name: "throw", discover: async () => { throw new Error("injected discovery crash"); } },
    { name: "null", discover: async () => null as never },
    { name: "unsupported", discover: async () => ({ schemaVersion: 999 }) as never },
]) {
    let executions = 0;
    const failureRuntime = createRecordSchedulerRuntime({
        mode: "test",
        ownerId: `record-scheduler-discovery-${failure.name}`,
        executeForTest: async () => {
            executions += 1;
            return "must not execute";
        },
        discover: failure.discover,
    });
    const admitted = await failureRuntime.admit({
        kind: "record-batch-update",
        requestKey: `post-admission-discovery-${failure.name}`,
        requestSummary: { operation: "record-batch-update", workspaceHash: `failure-${failure.name}`, dataChain: "codex" },
        resumePayload: { kind: "record-batch-update", phase: "preparing", resumeKey: `failure-${failure.name}`, workspaceHash: `failure-${failure.name}`, dataChain: "codex", modelChain: "codex", request: {} },
        requestMode: "normal",
        discovery: {
            kind: "record-batch-update",
            selector: "normal",
            requestKey: `failure-discovery-${failure.name}`,
            hosts: ["codex"],
        },
        execute: async () => "legacy adapter must not run",
    });
    assert.notEqual(admitted.outcome, "UnknownOutcome", `${failure.name} discovery must fail only after confirmed admission`);
    if (admitted.outcome === "UnknownOutcome") throw new Error(admitted.reasons.join("; "));
    await failureRuntime.waitForTerminal(admitted.taskId, 10);
    const ledger = currentSchedulerLedger(admitted.taskId);
    assert.equal(ledger.task.admission.state, "EnvelopeBound");
    assert.equal(ledger.task.state, "RepairRequired", `${failure.name} discovery must persist RepairRequired on the admitted ledger`);
    assert.equal(executions, 0);
}

fs.mkdirSync(path.join(dataRoot, "record-task-recovery"), { recursive: true });

const malformedWorkspace = path.join(dataRoot, "malformed-ledger-workspace");
const malformedIdentity = batchResumeIdentity(malformedWorkspace, 71);
fs.writeFileSync(malformedIdentity.ledgerPath, "null", "utf8");
const malformedLedgerCount = listRecordSchedulerLedgerTaskIds().length;
const malformedExecutions = fakeExecutions;
const malformedBatch = await startFixtureBatch(malformedWorkspace, 71);
const malformedTaskId = taskIdFrom(responseText(malformedBatch));
await testRuntime.waitForTerminal(malformedTaskId, 10);
assert.equal(testRuntime.status(malformedTaskId)?.state, "RepairRequired", "malformed legacy ledger must persist RepairRequired on its scheduler ledger");
assert.equal(listRecordSchedulerLedgerTaskIds().length, malformedLedgerCount + 1, "malformed background batch must still use exactly one scheduler admission");
assert.equal(fakeExecutions, malformedExecutions, "malformed legacy ledger must stop before fake/provider execution");

const obsoleteWorkspace = path.join(dataRoot, "obsolete-ledger-workspace");
const obsoleteIdentity = batchResumeIdentity(obsoleteWorkspace, 72);
fs.writeFileSync(obsoleteIdentity.ledgerPath, JSON.stringify({
    version: 0,
    resumeKey: obsoleteIdentity.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: [],
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [],
}), "utf8");
const obsoleteBatch = await startFixtureBatch(obsoleteWorkspace, 72);
const obsoleteTaskId = taskIdFrom(responseText(obsoleteBatch));
await testRuntime.waitForTerminal(obsoleteTaskId, 10);
assert.equal(testRuntime.status(obsoleteTaskId)?.state, "RepairRequired", "unsupported legacy ledger version must be rejected as RepairRequired");

const v1Workspace = path.join(dataRoot, "v1-ledger-workspace");
const v1Identity = batchResumeIdentity(v1Workspace, 73);
fs.writeFileSync(v1Identity.ledgerPath, JSON.stringify({
    version: 1,
    resumeKey: v1Identity.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: [{
        id: sharedStaleSource.identity.conversationId,
        workspace: sharedFrozenWorkspace,
    }],
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [],
}), "utf8");
const v1Batch = await startFixtureBatch(v1Workspace, 73);
const v1TaskId = taskIdFrom(responseText(v1Batch));
await testRuntime.waitForTerminal(v1TaskId, 10);
assert.equal(testRuntime.status(v1TaskId)?.state, "Succeeded", "allowed v1 ledger must replay through the admitted scheduler task");
const normalizedV1Ledger = JSON.parse(fs.readFileSync(v1Identity.ledgerPath, "utf8"));
assert.equal(normalizedV1Ledger.version, 2, "allowed v1 ledger must be normalized to v2");
assert.deepEqual(normalizedV1Ledger.candidates, [{
    id: sharedStaleSource.identity.conversationId,
    workspace: sharedFrozenWorkspace,
    workspaceHash: sharedStaleSource.identity.workspace.workspaceId,
    chain: "codex",
    lastModifiedMs: 2,
    selectionKind: "stale",
    refreshExisting: true,
}], "v1 migration must bind the scheduler frozen candidate identity");

const driftWorkspace = path.join(dataRoot, "identity-drift-ledger-workspace");
const driftIdentity = batchResumeIdentity(driftWorkspace, 74);
fs.writeFileSync(driftIdentity.ledgerPath, JSON.stringify({
    version: 2,
    resumeKey: driftIdentity.resumeKey,
    updatedAt: new Date().toISOString(),
    candidates: [{
        id: "unrelated-succeeded-candidate",
        workspace: driftWorkspace,
        chain: "codex",
        lastModifiedMs: 1,
        selectionKind: "fresh",
        refreshExisting: true,
    }],
    completed: [],
    skipped: [],
    failed: [],
    inFlight: [],
}), "utf8");
const driftBatch = await startFixtureBatch(driftWorkspace, 74);
const driftTaskId = taskIdFrom(responseText(driftBatch));
await testRuntime.waitForTerminal(driftTaskId, 10);
assert.equal(testRuntime.status(driftTaskId)?.state, "RepairRequired", "v2 legacy identity drift must persist RepairRequired on the newly admitted scheduler ledger");

fs.rmSync(path.join(dataRoot, "tasks", `${backgroundTaskId}.json`), { force: true });
const ledgerStatus = await recordManage({ action: "task_status", taskId: backgroundTaskId });
assert.match(responseText(ledgerStatus), /Record scheduler 任务：Succeeded/u, "record task_status must read scheduler ledger after projection removal");
const genericLedgerStatus = await backgroundStatus({ taskId: backgroundTaskId });
assert.match(responseText(genericLedgerStatus), /Record scheduler 任务：Succeeded/u, "generic status must delegate scheduler task IDs to ledger control");

const blocked = await recordManage({
    action: "update",
    background: true,
    conversationId: "cancelled-conversation",
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
const blockedTaskId = taskIdFrom(responseText(blocked));
    for (let attempt = 0; attempt < 1_000 && !releaseBlocked; attempt += 1) await sleep(10);
assert.ok(releaseBlocked, "fake scheduler task should begin before cancellation");
fs.rmSync(path.join(dataRoot, "tasks", `${blockedTaskId}.json`), { force: true });
const cancelled = await backgroundCancel({ taskId: blockedTaskId, reason: "test cancel" });
assert.match(responseText(cancelled), /Record scheduler cancel/u, "scheduler cancellation must read ledger control even when projection is missing");
releaseBlocked?.();
const blockedTerminalStatus = await testRuntime.waitForTerminal(blockedTaskId, 10);
assert.equal(blockedTerminalStatus?.state, "Cancelled", "running cancellation must settle after the late fake result is discarded");

const missingLedger = await recordManage({
    action: "update",
    background: true,
    conversationId: "missing-ledger-cancel",
    workspace: dataRoot,
    dataChain: "codex",
    modelChain: "codex",
    chain: "codex",
});
const missingLedgerTaskId = taskIdFrom(responseText(missingLedger));
for (let attempt = 0; attempt < 1_000 && !releaseMissingLedger; attempt += 1) await sleep(10);
assert.ok(releaseMissingLedger, "missing-ledger fixture should remain running before control-plane checks");
fs.rmSync(recordSchedulerLedgerPath(missingLedgerTaskId), { force: true });

const missingLedgerRecordStatus = await recordManage({ action: "task_status", taskId: missingLedgerTaskId });
assert.match(responseText(missingLedgerRecordStatus), /权威 scheduler ledger 不可读取.*generic status\/cancel\/recovery/u, "record task_status must fail closed when only a scheduler projection remains");
const missingLedgerGenericStatus = await backgroundStatus({ taskId: missingLedgerTaskId });
assert.match(responseText(missingLedgerGenericStatus), /权威 scheduler ledger 不可读取.*generic status\/cancel/u, "generic task_status must not trust a scheduler projection after ledger loss");
const missingLedgerRecordCancel = await recordManage({ action: "cancel", taskId: missingLedgerTaskId });
assert.match(responseText(missingLedgerRecordCancel), /权威 scheduler ledger 不可读取.*generic status\/cancel\/recovery/u, "record cancel must not fall back to generic cancellation after ledger loss");
const missingLedgerGenericCancel = await backgroundCancel({ taskId: missingLedgerTaskId, reason: "must fail closed" });
assert.match(responseText(missingLedgerGenericCancel), /权威 scheduler ledger 不可读取.*generic status\/cancel/u, "generic cancel must not mutate a scheduler projection after ledger loss");
assert.equal(getBackgroundTask(missingLedgerTaskId)?.status, "running", "failed-closed public controls must leave the scheduler projection unchanged");

__testEvictFromMemory(missingLedgerTaskId);
const restartedRecordStatus = await recordManage({ action: "task_status", taskId: missingLedgerTaskId });
assert.match(responseText(restartedRecordStatus), /权威 scheduler ledger 不可读取.*generic status\/cancel\/recovery/u, "record task_status must retain RepairRequired classification after the in-memory projection is evicted");
const restartedGenericStatus = await backgroundStatus({ taskId: missingLedgerTaskId });
assert.match(responseText(restartedGenericStatus), /权威 scheduler ledger 不可读取.*generic status\/cancel/u, "generic task_status must retain RepairRequired classification after restart-style eviction");
const restartedRecordCancel = await recordManage({ action: "cancel", taskId: missingLedgerTaskId });
assert.match(responseText(restartedRecordCancel), /权威 scheduler ledger 不可读取.*generic status\/cancel\/recovery/u, "record cancel must remain fail closed after restart-style eviction");
const restartedGenericCancel = await backgroundCancel({ taskId: missingLedgerTaskId, reason: "must remain fail closed" });
assert.match(responseText(restartedGenericCancel), /权威 scheduler ledger 不可读取.*generic status\/cancel/u, "generic cancel must remain fail closed after restart-style eviction");
const persistedProjectionPath = path.join(dataRoot, "tasks", `${missingLedgerTaskId}.json`);
assert.equal(JSON.parse(fs.readFileSync(persistedProjectionPath, "utf8")).status, "running", "restart-style control checks must not rewrite the persisted projection");

releaseMissingLedger?.();
await sleep(50);
assert.notEqual(JSON.parse(fs.readFileSync(persistedProjectionPath, "utf8")).status, "cancelled", "missing-ledger scheduler task must never be rewritten as a generic cancelled task");

let clock = 0;
let releaseAhead: (() => void) | undefined;
const aheadGate = new Promise<void>(resolve => { releaseAhead = resolve; });
const aheadRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-ahead-test",
    now: () => new Date(1_700_000_000_000 + (clock += 1_000)),
    executeForTest: async () => {
        await aheadGate;
        return "ahead test complete";
    },
});
const aheadAdmissions = [];
for (const workspaceHash of ["workspace-a", "workspace-b", "workspace-c"]) {
    aheadAdmissions.push(await aheadRuntime.admit({
        kind: "record-update",
        requestKey: `ahead:${workspaceHash}`,
        requestSummary: { operation: "record-update", conversationId: `ahead-${workspaceHash}`, workspaceHash, dataChain: "codex" },
        resumePayload: { kind: "record-update", conversationId: `ahead-${workspaceHash}`, workspace: workspaceHash, workspaceHash, dataChain: "codex", modelChain: "codex" },
        requestMode: "normal",
        execute: async () => "legacy adapter must not run in test mode",
    }));
}
assert.ok(aheadAdmissions.every(result => result.outcome !== "UnknownOutcome"), JSON.stringify(aheadAdmissions));
const thirdAhead = aheadAdmissions[2];
assert.notEqual(thirdAhead.outcome, "UnknownOutcome");
if (thirdAhead.outcome !== "UnknownOutcome") {
    assert.equal(aheadRuntime.status(thirdAhead.taskId)?.aheadTaskCount, 2, "aheadTaskCount must count earlier nonterminal ledgers across workspaces");
}
releaseAhead?.();
for (const admission of aheadAdmissions) {
    if (admission.outcome !== "UnknownOutcome") await aheadRuntime.waitForTerminal(admission.taskId, 10);
}

const brokenTaskId = "record-scheduler-broken-ledger";
fs.mkdirSync(path.dirname(recordSchedulerLedgerPath(brokenTaskId)), { recursive: true });
fs.writeFileSync(recordSchedulerLedgerPath(brokenTaskId), "{broken", "utf8");
assert.equal(testRuntime.status(brokenTaskId)?.state, "RepairRequired", "broken ledger must remain repair-required instead of rebuilding a projection");
assert.equal(fs.existsSync(path.join(dataRoot, "tasks", `${brokenTaskId}.json`)), false, "status must not rebuild a BackgroundTask projection for broken ledger");
fs.rmSync(recordSchedulerLedgerPath(brokenTaskId), { force: true });

let legacyExecutions = 0;
const productionFixtureWorkspace = path.join(dataRoot, "production-discovery-workspace");
const productionApiCalls: string[] = [];
const productionEvidenceOptions: Record<SourceEvidenceHost, Parameters<typeof fixtureEnumeration>[3]> = {
    codex: { complete: false },
    "claude-code": { cacheBypassed: false },
    windsurf: { error: true },
    antigravity: { complete: false, error: true },
};
const productionEnvelope = (host: SourceEvidenceHost, conversationId: string) => fixtureEnumeration(
    fixtureSource(host, productionFixtureWorkspace, conversationId),
    `production-${host}-${conversationId}`,
    unresolvedHosts.indexOf(host) + 1,
    productionEvidenceOptions[host],
);
const productionIds = (host: SourceEvidenceHost) => [`${host}-production-1`, `${host}-production-2`];
const defaultLegacyDiscoveryRuntime = createRecordSchedulerRuntime({
    mode: "legacy",
    productionSourceApis: {
        listCodexThreads: () => {
            productionApiCalls.push("codex:list");
            return productionIds("codex").map(id => ({ id, title: id, cwd: productionFixtureWorkspace, updatedAtMs: fixtureTimeMs })) as never;
        },
        enumerateCodex: async options => {
            productionApiCalls.push("codex:evidence");
            return { evidence: productionEnvelope("codex", options.conversationId).evidence, threads: [] } as never;
        },
        fetchCodex: async () => { throw new Error("unexpected codex exact fetch"); },
        listClaudeCodeThreads: () => {
            productionApiCalls.push("claude-code:list");
            return productionIds("claude-code").map(id => ({ id, title: id, cwd: productionFixtureWorkspace, updatedAtMs: fixtureTimeMs })) as never;
        },
        enumerateClaudeCode: options => {
            productionApiCalls.push("claude-code:evidence");
            const enumeration = productionEnvelope("claude-code", options.conversationId).evidence;
            return { enumeration, session: null, sessions: [] } as never;
        },
        fetchClaudeCode: () => { throw new Error("unexpected claude-code exact fetch"); },
        listWindsurfThreads: async () => {
            productionApiCalls.push("windsurf:list");
            return productionIds("windsurf").map(id => ({
                id,
                cascadeId: id,
                title: id,
                cwd: productionFixtureWorkspace,
                lastModifiedTime: new Date(fixtureTimeMs).toISOString(),
            })) as never;
        },
        scanWindsurf: async conversationId => {
            productionApiCalls.push("windsurf:evidence");
            const enumeration = productionEnvelope("windsurf", conversationId);
            return { enumeration: enumeration.evidence, exactFetch: fixtureExactFetch(enumeration) } as never;
        },
        listAntigravityConversations: () => {
            productionApiCalls.push("antigravity:list");
            return productionIds("antigravity").map(id => ({ id, title: id, mtime: new Date(fixtureTimeMs), sizeKB: 20 }));
        },
        createAntigravityAdapter: () => ({
            enumerate: async request => {
                productionApiCalls.push("antigravity:evidence");
                return productionEnvelope("antigravity", request.cascadeId).evidence;
            },
            fetchExact: async request => fixtureExactFetch(productionEnvelope("antigravity", request.cascadeId)),
            readFull: async () => { throw new Error("unexpected antigravity full read"); },
        }) as never,
    },
});
const defaultLegacySnapshot = await defaultLegacyDiscoveryRuntime.discover({
    kind: "stale_check",
    selector: "stale_only",
    requestKey: "default-legacy-production-discovery",
    workspaceHash: "production-workspace-hash",
    workspacePath: productionFixtureWorkspace,
    hosts: [...unresolvedHosts],
    limit: 4,
});
assert.deepEqual(
    [...new Set(productionApiCalls.filter(call => call.endsWith(":list")))].sort(),
    unresolvedHosts.map(host => `${host}:list`).sort(),
    "default legacy production discovery must call every host discovery API",
);
assert.deepEqual(
    [...new Set(productionApiCalls.filter(call => call.endsWith(":evidence")))].sort(),
    [],
    "listed candidates must freeze from metadata without full source evidence reads",
);
assert.deepEqual(
    defaultLegacySnapshot.candidates.map(candidate => candidate.classification),
    ["Missing", "Missing", "Missing", "Missing"],
    "complete metadata listings must expose missing Record candidates without loading conversation bodies",
);

const readerDelegationCalls: Array<{ host: SourceEvidenceHost; conversationId: string }> = [];
const readerDelegationRuntime = createRecordSchedulerRuntime({
    mode: "legacy",
    productionSourceApis: {
        listCodexThreads: () => [{ id: "reader-codex", title: "reader-codex", cwd: productionFixtureWorkspace, updatedAtMs: fixtureTimeMs }] as never,
        listClaudeCodeThreads: () => [{ id: "reader-claude-code", title: "reader-claude-code", cwd: productionFixtureWorkspace, updatedAtMs: fixtureTimeMs }] as never,
        listWindsurfThreads: async () => [{ id: "reader-windsurf", cascadeId: "reader-windsurf", title: "reader-windsurf", cwd: productionFixtureWorkspace, lastModifiedTime: new Date(fixtureTimeMs).toISOString() }] as never,
        listAntigravityConversations: () => [{ id: "reader-antigravity", title: "reader-antigravity", mtime: new Date(fixtureTimeMs), sizeKB: 1 }],
    },
    productionSourceReader: {
        scan: async request => {
            readerDelegationCalls.push({ host: request.host, conversationId: request.conversationId });
            const source = fixtureSource(request.host, productionFixtureWorkspace, request.conversationId);
            const enumeration = fixtureEnumeration(source, `reader-revision-${request.host}`, 1).evidence;
            const exactFetch = fixtureExactFetch({ evidence: enumeration, revisionSequence: 1, title: request.conversationId });
            const fullSourceRead = buildFullSourceReadEvidence({
                adapterVersion: SOURCE_EVIDENCE_ADAPTER_VERSION,
                host: request.host,
                identity: source.identity,
                sourceRevision: enumeration.sourceRevision,
                pagination: enumeration.pagination,
                enumerationComplete: true,
                cacheBypassed: true,
                exactFetchResult: "present",
                errors: [],
                warnings: [],
                observedAt: { ...enumeration.observedAt, scanId: `reader-full-${request.host}`, sequence: 2 },
                content: { mode: "full", byteLength: 1, contentHash: fixtureHash({ request }), roundRange: { start: 1, end: 1 }, truncated: false, staleCache: false },
            });
            return {
                host: request.host,
                scanId: `reader-scan-${request.host}`,
                enumeration,
                exactFetch,
                fullSourceRead,
                sourceSnapshot: null,
                classification: { state: "Present", reason: "exact-fetch-present" },
                qualifiedAbsence: null,
            } as never;
        },
    } as never,
});
await readerDelegationRuntime.discover({
    kind: "stale_check",
    selector: "normal",
    requestKey: "production-source-reader-four-hosts",
    workspaceHash: "production-source-reader-workspace",
    workspacePath: productionFixtureWorkspace,
    hosts: [...unresolvedHosts],
    limit: 4,
});
assert.deepEqual(readerDelegationCalls, [], "listed discovery candidates must not delegate to the full source reader");
const unlistedRecordSnapshot = await readerDelegationRuntime.discover({
    kind: "stale_check",
    selector: "normal",
    requestKey: "production-source-reader-unlisted-record",
    workspaceHash: "production-source-reader-workspace",
    workspacePath: productionFixtureWorkspace,
    hosts: ["codex"],
    records: [{
        conversationId: "reader-codex-unlisted-record",
        title: "reader-codex-unlisted-record",
        workspaceHash: "production-source-reader-workspace",
        workspacePath: productionFixtureWorkspace,
        host: "codex",
        lastUpdatedAt: new Date(fixtureTimeMs).toISOString(),
        recordBodyHash: fixtureHash({ kind: "unlisted-record" }),
    }],
    limit: 1,
});
assert.deepEqual(readerDelegationCalls, [], "an unlisted existing Record must not delegate to the full source reader without an explicit target");
assert.equal(unlistedRecordSnapshot.candidates[0]?.classification, "Unresolved", "an unlisted existing Record must remain unresolved instead of scanning the conversation body");
await readerDelegationRuntime.discover({
    kind: "stale_check",
    selector: "normal",
    requestKey: "production-source-reader-missing-target",
    workspaceHash: "production-source-reader-workspace",
    workspacePath: productionFixtureWorkspace,
    hosts: ["codex"],
    targets: [{
        host: "codex",
        conversationId: "reader-codex-missing-target",
        workspaceHash: "production-source-reader-workspace",
        workspacePath: productionFixtureWorkspace,
    }],
    limit: 1,
});
assert.deepEqual(readerDelegationCalls, [{ host: "codex", conversationId: "reader-codex-missing-target" }], "an unlisted exact target may use one guarded full-source fallback");

const revisionWorkspaceHash = "revision-ordering-workspace";
const revisionConversationId = "revision-ordering-conversation";
const revisionSource = fixtureSource("codex", productionFixtureWorkspace, revisionConversationId);
revisionSource.identity.workspace.workspaceId = revisionWorkspaceHash;
let authoritativeRevision = "revision-v1";
let authoritativeUpdatedAtMs = fixtureTimeMs + 60_000;
const revisionOrderingRuntime = createRecordSchedulerRuntime({
    mode: "legacy",
    productionSourceApis: {
        listCodexThreads: () => [{
            id: revisionConversationId,
            title: revisionConversationId,
            cwd: productionFixtureWorkspace,
            updatedAtMs: authoritativeUpdatedAtMs,
        }] as never,
        enumerateCodex: async () => ({
            evidence: fixtureUnsequencedEnumeration(revisionSource, authoritativeRevision, 1).evidence,
            threads: [],
        }) as never,
        fetchCodex: async () => { throw new Error("unexpected revision ordering exact fetch"); },
    },
});
const discoverRevisionFixture = async (
    requestKey: string,
    record: { lastUpdatedAt: string; coveredRevision?: string; coveredRevisionSequence?: number | null },
) => revisionOrderingRuntime.discover({
    kind: "stale_check",
    selector: "normal",
    requestKey,
    workspaceHash: revisionWorkspaceHash,
    workspacePath: productionFixtureWorkspace,
    hosts: ["codex"],
    records: [{
        conversationId: revisionConversationId,
        title: revisionConversationId,
        workspaceHash: revisionWorkspaceHash,
        workspacePath: productionFixtureWorkspace,
        host: "codex",
        lastUpdatedAt: record.lastUpdatedAt,
        recordBodyHash: fixtureHash({ requestKey }),
        ...(record.coveredRevision ? { coveredRevision: record.coveredRevision } : {}),
        ...(record.coveredRevisionSequence !== undefined ? { coveredRevisionSequence: record.coveredRevisionSequence } : {}),
    }],
});
const oldUnboundRecordSnapshot = await discoverRevisionFixture("unbound-record-older-than-source", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs - 120_000).toISOString(),
});
assert.equal(oldUnboundRecordSnapshot.candidates[0]?.classification, "Stale", "authoritative host revision ordering must classify a clearly older unbound Record as Stale");
const newerUnboundRecordSnapshot = await discoverRevisionFixture("unbound-record-newer-than-source", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs + 120_000).toISOString(),
});
assert.equal(newerUnboundRecordSnapshot.candidates[0]?.classification, "Unresolved", "Record file time must never backfill the current source revision or authorize Fresh");
const boundFreshSnapshot = await discoverRevisionFixture("bound-record-current-source", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs).toISOString(),
    coveredRevision: authoritativeRevision,
    coveredRevisionSequence: authoritativeUpdatedAtMs,
});
assert.equal(boundFreshSnapshot.candidates[0]?.classification, "Fresh", "explicit coveredRevision metadata may authorize Fresh");
authoritativeRevision = "revision-v2";
authoritativeUpdatedAtMs += 120_000;
const advancedSourceSnapshot = await discoverRevisionFixture("bound-record-source-advanced", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs - 120_000).toISOString(),
    coveredRevision: "revision-v1",
    coveredRevisionSequence: authoritativeUpdatedAtMs - 120_000,
});
assert.equal(advancedSourceSnapshot.candidates[0]?.classification, "Stale", "a source revision that advances after the frozen Record snapshot must never remain Fresh");

authoritativeRevision = "revision-v2";
authoritativeUpdatedAtMs += 120_000;
const p1CacheFirst = await discoverRevisionFixture("p1-same-key-source-advance", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs).toISOString(),
    coveredRevision: "revision-v2",
    coveredRevisionSequence: authoritativeUpdatedAtMs,
});
assert.equal(p1CacheFirst.candidates[0]?.classification, "Fresh", "P1 fixture must begin with the Record covered at the current source revision");
authoritativeRevision = "revision-v3";
authoritativeUpdatedAtMs += 120_000;
const p1CacheSecond = await discoverRevisionFixture("p1-same-key-source-advance", {
    lastUpdatedAt: new Date(authoritativeUpdatedAtMs - 120_000).toISOString(),
    coveredRevision: "revision-v2",
    coveredRevisionSequence: authoritativeUpdatedAtMs - 120_000,
});
assert.equal(p1CacheSecond.candidates[0]?.classification, "Stale", "同一 runtime、同一 requestKey 在 source revision 前进后必须重新真实 I/O，不能复用成功 discovery cache");

let singleFlightDiscoveryCalls = 0;
let releaseSingleFlight: (() => void) | undefined;
const singleFlightRuntime = createRecordSchedulerRuntime({
    mode: "legacy",
    discover: async () => {
        singleFlightDiscoveryCalls += 1;
        if (singleFlightDiscoveryCalls === 1) {
            await new Promise<void>(resolve => { releaseSingleFlight = resolve; });
        }
        return discoverRecordCandidates(sharedDiscoveryInput);
    },
});
const singleFlightRequest = {
    kind: "stale_check" as const,
    selector: "stale_only" as const,
    requestKey: "p1-concurrent-single-flight",
    workspaceHash: "p1-single-flight-workspace",
    workspacePath: sharedFrozenWorkspace,
};
const concurrentDiscovery = Promise.all([
    singleFlightRuntime.discover(singleFlightRequest),
    singleFlightRuntime.discover(singleFlightRequest),
]);
await sleep(10);
assert.equal(singleFlightDiscoveryCalls, 1, "相同并发 discovery 只能共享尚未完成的 single-flight");
releaseSingleFlight?.();
await concurrentDiscovery;
await singleFlightRuntime.discover(singleFlightRequest);
assert.equal(singleFlightDiscoveryCalls, 2, "single-flight 完成后必须移除，后续请求必须重新 discovery");

let frozenSnapshotDiscoveryCalls = 0;
const frozenSnapshotRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "candidate-snapshot-spool-fixture",
    executeForTest: async () => "candidate snapshot spool fixture complete",
    discover: async () => {
        frozenSnapshotDiscoveryCalls += 1;
        return discoverRecordCandidates(sharedDiscoveryInput);
    },
    productionSourceReader: testProductionSourceReader as never,
});
const frozenSnapshotAdmission = await frozenSnapshotRuntime.admit({
    kind: "record-batch-update",
    requestKey: "candidate-snapshot-spool-fixture",
    requestSummary: { operation: "record-batch-update", workspaceHash: "candidate-snapshot-spool", dataChain: "codex" },
    resumePayload: { kind: "record-batch-update", phase: "preparing", resumeKey: "candidate-snapshot-spool", workspaceHash: "candidate-snapshot-spool", dataChain: "codex", modelChain: "codex", request: {} },
    requestMode: "normal",
    discovery: { ...singleFlightRequest, kind: "record-batch-update", selector: "normal", requestKey: "candidate-snapshot-spool-fixture" },
    execute: async () => "unexpected legacy executor",
});
assert.notEqual(frozenSnapshotAdmission.outcome, "UnknownOutcome");
if (frozenSnapshotAdmission.outcome === "UnknownOutcome") throw new Error("candidate snapshot fixture admission unexpectedly unresolved");
const frozenSnapshotStatus = await frozenSnapshotRuntime.waitForTerminal(frozenSnapshotAdmission.taskId, 10);
assert.equal(frozenSnapshotStatus?.state, "Succeeded", "synthetic frozen CandidateSnapshot fixture must settle before corruption recovery checks");
const frozenSnapshotLedger = currentSchedulerLedger(frozenSnapshotAdmission.taskId);
assert.match(frozenSnapshotLedger.candidateSnapshot.snapshotRef.path, /^\.record-scheduler-spool-v\d+\//u, "ledger CandidateSnapshot must point at a task-isolated immutable spool blob");
assert.equal(frozenSnapshotLedger.candidateSnapshot.snapshotHash, frozenSnapshotLedger.candidateSnapshot.snapshotRef.hash, "ledger CandidateSnapshot hash must be the verified spool content hash");
const restartedSnapshotRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "candidate-snapshot-spool-restart-fixture",
    executeForTest: async () => "must-not-run",
    discover: async () => {
        frozenSnapshotDiscoveryCalls += 1;
        throw new Error("restart recovery must not re-enumerate a frozen CandidateSnapshot");
    },
});
const restoredFrozenSnapshot = await restartedSnapshotRuntime.readFrozenDiscovery(frozenSnapshotAdmission.taskId);
assert.equal(restoredFrozenSnapshot.snapshot.snapshotId, "shared-handler-snapshot");
assert.equal(frozenSnapshotDiscoveryCalls, 1, "process restart recovery must read ledger+spool without another discovery call");
fs.writeFileSync(path.join(dataRoot, frozenSnapshotLedger.candidateSnapshot.snapshotRef.path), "corrupt", "utf8");
await assert.rejects(
    () => restartedSnapshotRuntime.readFrozenDiscovery(frozenSnapshotAdmission.taskId),
    /CandidateSnapshot .*缺失或损坏/u,
    "corrupted immutable CandidateSnapshot spool must fail closed as RepairRequired",
);

const zeroSeedHostCalls: string[] = [];
const zeroSeedFailureRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-zero-seed-host-failures",
    executeForTest: async () => "zero-seed host failure fixture complete",
    productionSourceApis: {
        listCodexThreads: () => {
            zeroSeedHostCalls.push("codex");
            throw new Error("codex zero-seed list failure");
        },
        listClaudeCodeThreads: () => {
            zeroSeedHostCalls.push("claude-code");
            throw new Error("claude-code zero-seed list failure");
        },
        listWindsurfThreads: async () => {
            zeroSeedHostCalls.push("windsurf");
            throw new Error("windsurf zero-seed list failure");
        },
        listAntigravityConversations: () => {
            zeroSeedHostCalls.push("antigravity");
            throw new Error("antigravity zero-seed list failure");
        },
    },
});
const allHostZeroSeedAdmission = await zeroSeedFailureRuntime.admit({
    kind: "record-batch-update",
    requestKey: "all-host-zero-seed-failure",
    requestSummary: { operation: "record-batch-update", workspaceHash: "all-host-zero-seed", dataChain: "auto" },
    resumePayload: { kind: "record-batch-update", phase: "preparing", resumeKey: "all-host-zero-seed", workspaceHash: "all-host-zero-seed", dataChain: "codex", modelChain: "codex", request: {} },
    requestMode: "normal",
    discovery: {
        kind: "record-batch-update",
        selector: "normal",
        requestKey: "all-host-zero-seed-discovery",
        workspaceHash: "all-host-zero-seed",
        workspacePath: path.join(dataRoot, "all-host-zero-seed"),
        hosts: [...unresolvedHosts],
        records: [],
    },
    execute: async () => "legacy adapter must not run in test mode",
});
assert.notEqual(allHostZeroSeedAdmission.outcome, "UnknownOutcome");
if (allHostZeroSeedAdmission.outcome === "UnknownOutcome") throw new Error(allHostZeroSeedAdmission.reasons.join("; "));
const allHostZeroSeedStatus = await zeroSeedFailureRuntime.waitForTerminal(allHostZeroSeedAdmission.taskId, 10);
assert.equal(allHostZeroSeedStatus?.state, "Deferred", "all-host zero-seed list failures must not become a false successful no-op");
const allHostZeroSeedLedger = currentSchedulerLedger(allHostZeroSeedAdmission.taskId);
assert.equal(allHostZeroSeedLedger.task.sourceResolution?.phase, "deferred");
assert.equal(allHostZeroSeedLedger.task.sourceResolution?.selectedCount, null, "failed global scope enumeration must retain unknown selectedCount");
assert.equal(allHostZeroSeedLedger.task.sourceResolution?.unresolvedCount, unresolvedHosts.length);
assert.equal(allHostZeroSeedLedger.task.recordItems.unresolved, 0, "scope-level unknowns must not fabricate candidate-level unresolved counts");
assert.deepEqual([...zeroSeedHostCalls].sort(), [...unresolvedHosts].sort(), "all four production host lists must be invoked even when every list fails with zero seeds");
assert.equal(allHostZeroSeedLedger.candidateSnapshot.candidates.length, 0, "zero seeds must not fabricate conversation candidates");
assert.deepEqual(
    allHostZeroSeedLedger.candidateSnapshot.enumerations.map(enumeration => enumeration.chain).sort(),
    [...unresolvedHosts].sort(),
    "the scheduler CandidateSnapshot must retain one chain-level enumeration for every invoked host",
);
assert.ok(
    allHostZeroSeedLedger.candidateSnapshot.enumerations.every(enumeration => (
        !enumeration.complete
        && !enumeration.paginationExhausted
        && enumeration.truncated
        && /zero-seed list failure/u.test(enumeration.error || "")
    )),
    "every failed zero-seed host must retain complete/pagination/truncated/error evidence",
);

const singleHostZeroSeedAdmission = await zeroSeedFailureRuntime.admit({
    kind: "record-batch-update",
    requestKey: "single-host-zero-seed-failure",
    requestSummary: { operation: "record-batch-update", workspaceHash: "single-host-zero-seed", dataChain: "codex" },
    resumePayload: { kind: "record-batch-update", phase: "preparing", resumeKey: "single-host-zero-seed", workspaceHash: "single-host-zero-seed", dataChain: "codex", modelChain: "codex", request: {} },
    requestMode: "normal",
    discovery: {
        kind: "record-batch-update",
        selector: "normal",
        requestKey: "single-host-zero-seed-discovery",
        workspaceHash: "single-host-zero-seed",
        workspacePath: path.join(dataRoot, "single-host-zero-seed"),
        hosts: ["codex"],
        records: [],
    },
    execute: async () => "legacy adapter must not run in test mode",
});
assert.notEqual(singleHostZeroSeedAdmission.outcome, "UnknownOutcome");
if (singleHostZeroSeedAdmission.outcome === "UnknownOutcome") throw new Error(singleHostZeroSeedAdmission.reasons.join("; "));
const singleHostZeroSeedStatus = await zeroSeedFailureRuntime.waitForTerminal(singleHostZeroSeedAdmission.taskId, 10);
assert.equal(singleHostZeroSeedStatus?.state, "Deferred", "single-host zero-seed list failure must not become a false successful no-op");
const singleHostZeroSeedLedger = currentSchedulerLedger(singleHostZeroSeedAdmission.taskId);
assert.equal(singleHostZeroSeedLedger.task.sourceResolution?.selectedCount, null);
assert.equal(singleHostZeroSeedLedger.task.sourceResolution?.deferredReason, "source_unresolved");
assert.equal(singleHostZeroSeedLedger.task.sourceResolution?.issues[0]?.code, "source-list-incomplete");
assert.equal(singleHostZeroSeedLedger.candidateSnapshot.candidates.length, 0, "single-host zero seed failure must not fabricate a candidate");
assert.deepEqual(singleHostZeroSeedLedger.candidateSnapshot.enumerations.map(enumeration => enumeration.chain), ["codex"]);
assert.match(singleHostZeroSeedLedger.candidateSnapshot.enumerations[0]?.error || "", /codex zero-seed list failure/u);

let explicitTargetReadCalls = 0;
let explicitTargetExecutions = 0;
const explicitTargetRuntime = createRecordSchedulerRuntime({
    mode: "test",
    ownerId: "record-scheduler-explicit-target-list-failure",
    executeForTest: async () => {
        explicitTargetExecutions += 1;
        return "explicit target executed from exact/full read";
    },
    productionSourceApis: {
        listCodexThreads: () => {
            throw new Error("explicit target host list unavailable");
        },
    },
    productionSourceReader: {
        scan: async request => {
            explicitTargetReadCalls += 1;
            return testProductionSourceReader.scan(request as never);
        },
    } as never,
});
const explicitTargetAdmission = await explicitTargetRuntime.admit({
    kind: "record-update",
    requestKey: "explicit-target-list-failure",
    requestSummary: { operation: "record-update", conversationId: sharedStaleSource.identity.conversationId, workspaceHash: sharedStaleSource.identity.workspace.workspaceId, dataChain: "codex" },
    resumePayload: { kind: "record-update", conversationId: sharedStaleSource.identity.conversationId, workspace: sharedStaleSource.identity.workspace.canonicalPath || "", workspaceHash: sharedStaleSource.identity.workspace.workspaceId, dataChain: "codex", modelChain: "codex" },
    requestMode: "normal",
    discovery: {
        kind: "record-update",
        selector: "normal",
        requestKey: "explicit-target-list-failure-discovery",
        workspaceHash: sharedStaleSource.identity.workspace.workspaceId,
        workspacePath: sharedStaleSource.identity.workspace.canonicalPath,
        hosts: ["codex"],
        records: [],
        targets: [{
            conversationId: sharedStaleSource.identity.conversationId,
            host: "codex",
            workspaceHash: sharedStaleSource.identity.workspace.workspaceId,
            workspacePath: sharedStaleSource.identity.workspace.canonicalPath,
            title: "explicit target",
        }],
    },
    execute: async () => "legacy adapter must not run in test mode",
});
assert.notEqual(explicitTargetAdmission.outcome, "UnknownOutcome");
if (explicitTargetAdmission.outcome === "UnknownOutcome") throw new Error(explicitTargetAdmission.reasons.join("; "));
const explicitTargetStatus = await explicitTargetRuntime.waitForTerminal(explicitTargetAdmission.taskId, 10);
assert.equal(explicitTargetStatus?.state, "Succeeded", "known explicit target must execute when exact/full read succeeds despite host list failure");
assert.equal(explicitTargetReadCalls, 2, "explicit target must perform discovery and materialization full reads");
assert.equal(explicitTargetExecutions, 1);
const explicitTargetLedger = currentSchedulerLedger(explicitTargetAdmission.taskId);
assert.equal(explicitTargetLedger.sourceSnapshots.length, 1);
assert.equal(explicitTargetLedger.task.sourceResolution?.phase, "materialized");
assert.equal(explicitTargetLedger.task.sourceResolution?.selectedCount, 1);
assert.equal(explicitTargetLedger.task.sourceResolution?.materializedCount, 1);
assert.equal(explicitTargetLedger.task.sourceResolution?.unresolvedCount, 0);
assert.match(explicitTargetLedger.candidateSnapshot.enumerations[0]?.error || "", /explicit target host list unavailable/u, "nonblocking list diagnostics must remain frozen in the CandidateSnapshot");

let legacyCollectorCalls = 0;
__recordConcurrencyTest.setBatchCandidateCollector(async () => {
    legacyCollectorCalls += 1;
    throw new Error("legacy candidate collector must not run from scheduler wiring");
});
__setRecordSchedulerRuntimeForTest(defaultLegacyDiscoveryRuntime);
try {
    const noFallbackBatch = await recordManage({
        action: "batch_update",
        background: false,
        workspace: productionFixtureWorkspace,
        dataChain: "codex",
        modelChain: "codex",
        stale_only: true,
        limit: 4,
    });
    assert.match(responseText(noFallbackBatch), /批量更新完成|Record scheduler 任务：(Succeeded|Deferred)|source materialization deferred|持久 no-op 成功/u);
    assert.equal(legacyCollectorCalls, 0, "legacy execution adapter must consume the scheduler frozen candidates without re-enumerating");
} finally {
    __recordConcurrencyTest.setBatchCandidateCollector(null);
    __setRecordSchedulerRuntimeForTest(testRuntime);
}

const legacyRuntime = createRecordSchedulerRuntime({ mode: "legacy" });
const legacy = await legacyRuntime.admit({
    kind: "record-update",
    requestKey: "legacy-default",
    requestSummary: { operation: "record-update", conversationId: "legacy-conversation", workspaceHash: "legacy-workspace", dataChain: "codex" },
    resumePayload: { kind: "record-update", conversationId: "legacy-conversation", workspace: "legacy-workspace", workspaceHash: "legacy-workspace", dataChain: "codex", modelChain: "codex" },
    requestMode: "normal",
    execute: async () => {
        legacyExecutions += 1;
        return "legacy adapter result";
    },
});
assert.notEqual(legacy.outcome, "UnknownOutcome");
if (legacy.outcome !== "UnknownOutcome") await legacyRuntime.waitForTerminal(legacy.taskId, 10);
assert.equal(legacyExecutions, 1, "legacy mode should preserve one legacy adapter execution without enabling a provider scheduler");

const shadowRuntime = createRecordSchedulerRuntime({ mode: "shadow" });
let shadowExecutions = 0;
const shadow = await shadowRuntime.admit({
    kind: "record-update",
    requestKey: "shadow-default",
    requestSummary: { operation: "record-update", conversationId: "shadow-conversation", workspaceHash: "shadow-workspace", dataChain: "codex" },
    resumePayload: { kind: "record-update", conversationId: "shadow-conversation", workspace: "shadow-workspace", workspaceHash: "shadow-workspace", dataChain: "codex", modelChain: "codex" },
    requestMode: "normal",
    execute: async () => {
        shadowExecutions += 1;
        return "shadow adapter result";
    },
});
assert.notEqual(shadow.outcome, "UnknownOutcome");
if (shadow.outcome !== "UnknownOutcome") await shadowRuntime.waitForTerminal(shadow.taskId, 10);
assert.equal(shadowExecutions, 1, "shadow mode must not enable provider enforcement");

const missingInputRuntime = createRecordSchedulerRuntime({
    mode: "legacy",
    sourceEvidenceAdapter: { buildDiscoveryInput: async () => undefined as never },
});
await assert.rejects(
    missingInputRuntime.discover({ kind: "stale_check", selector: "stale_only", requestKey: "missing-production-input" }),
    /RepairRequired|缺少生产 input/u,
);

const testWithoutFake = createRecordSchedulerRuntime({ mode: "test" });
await assert.rejects(
    testWithoutFake.admit({
        kind: "record-update",
        requestKey: "test-without-fake",
        requestSummary: { operation: "record-update", conversationId: "test-no-fake", workspaceHash: "test", dataChain: "codex" },
        resumePayload: { kind: "record-update", conversationId: "test-no-fake", workspace: "test", workspaceHash: "test", dataChain: "codex", modelChain: "codex" },
        requestMode: "normal",
        execute: async () => "must not run",
    }),
    /fake executor/u,
);

const enforcedRuntime = createRecordSchedulerRuntime({ mode: "enforced" });
let enforcedExecutions = 0;
const enforced = await enforcedRuntime.admit({
    kind: "record-update",
    requestKey: "enforced-production-enabled",
    requestSummary: { operation: "record-update", conversationId: "enforced", workspaceHash: "enforced", dataChain: "codex" },
    resumePayload: { kind: "record-update", conversationId: "enforced", workspace: "enforced", workspaceHash: "enforced", dataChain: "codex", modelChain: "codex" },
    requestMode: "normal",
    execute: async () => {
        enforcedExecutions += 1;
        return "enforced production execution";
    },
});
assert.notEqual(enforced.outcome, "UnknownOutcome");
if (enforced.outcome !== "UnknownOutcome") await enforcedRuntime.waitForTerminal(enforced.taskId, 10);
assert.equal(enforcedExecutions, 1, "enforced runtime must execute the admitted production callback exactly once");

const recordToolSource = fs.readFileSync(path.join(process.cwd(), "src", "tools", "record.ts"), "utf8");
    assert.match(recordToolSource, /schedulerManagedExecution:\s*true/u, "production tools must mark generation scheduler-managed");
    assert.match(recordToolSource, /schedulerModelCall:\s*schedulerSession\.schedulerModelCall/u, "production tools must route model calls through the session pump");
    assert.match(recordToolSource, /finalizeSchedulerLocalRecord\(schedulerSession/u, "production tools must local-finalize through the scheduler session");
    assert.match(recordToolSource, /record-first-publication:v1:\$\{crypto\.createHash\("sha256"\)/u, "first-publication token must be versioned SHA-256, not task/random derived");
    assert.match(recordToolSource, /recordStoreHash:\s*source\.snapshot\.workspaceHash/u, "production session must register the frozen source workspaceHash");
    assert.match(recordToolSource, /schedulerOwner:\s*\{ ownerId: execution\.runtime\.ownerId \}/u, "production session must register the runtime owner");
    assert.match(recordToolSource, /control:\s*execution\.runtime\.control,[\s\S]*spool:\s*execution\.runtime\.control\.spool/u, "production session must use the runtime control and spool");
    assert.match(recordToolSource, /RECORD_SCHEDULER_COORDINATOR_OWNER_ID\s*=\s*`record-tools:\$\{process\.pid\}:\$\{crypto\.randomUUID\(\)\}`/u, "coordinator owner must be process-unique at module scope");
    assert.match(recordToolSource, /if \(!options\.schedulerExecution && existingBestHash/u, "scheduler-managed update must not enter workspace alias copy migration");
    assert.match(recordToolSource, /scheduler\.resumeExecution\(task\.id, context/u, "recovery handlers must resume execution rather than only recover ownership");
    assert.match(recordToolSource, /\}, async \(\) => \{\s*const recovery = await schedulerRecoveryPayload\(task\);\s*recoveryPayload = recovery\.payload;\s*return schedulerRecoveryDescriptor\(task, recovery\);/u, "recovery descriptor must be lazy and execute only after runtime obtains the owner");
    assert.match(recordToolSource, /resumeSchedulerBackgroundTask/u, "manual record_manage recover must invoke the registered resume handler");
    assert.match(recordToolSource, /source\.snapshot\.workspaceHash === resumePayload\.workspaceHash/u, "scheduler update must match frozen sources by canonical chain/workspaceHash/conversationId");
    assert.match(recordToolSource, /item\.workspaceHash === source\.snapshot\.workspaceHash/u, "scheduler batch matching must use frozen canonical workspaceHash");
    assert.match(recordToolSource, /return Math\.max\(PROVIDER_CONTROL_PHYSICAL_MAX, configured\)/u, "batch materialization window must not fall below physical provider capacity");
    assert.match(recordToolSource, /if \(schedulerManaged && !frozenSource\) \{\s*throw new RecordSchedulerRepairRequiredError\(/u, "scheduler batches must fail instead of live-loading when an admitted frozen source is absent");
const updateStart = recordToolSource.indexOf("async function handleUpdate");
const schedulerFinalizeStart = recordToolSource.indexOf("if (schedulerSession) {", updateStart);
const directPersistenceStart = recordToolSource.indexOf("await runRecordPersistenceTestHook", schedulerFinalizeStart);
assert.ok(updateStart >= 0 && schedulerFinalizeStart >= 0 && directPersistenceStart > schedulerFinalizeStart, "scheduler update finalize branch must be locatable");
const schedulerFinalizeBranch = recordToolSource.slice(schedulerFinalizeStart, directPersistenceStart);
assert.doesNotMatch(schedulerFinalizeBranch, /writeRecord\(|buildAndPersistRecordReaderIndex\(/u, "scheduler finalize branch must not call legacy direct write/index persistence");
    const schedulerBatchStart = recordToolSource.indexOf("function schedulerBatchCandidates");
const schedulerBatchEnd = recordToolSource.indexOf("function projectRecordBatchOutcomeInMemory", schedulerBatchStart);
assert.ok(schedulerBatchStart >= 0 && schedulerBatchEnd > schedulerBatchStart, "scheduler candidate matcher must be locatable");
    assert.doesNotMatch(recordToolSource.slice(schedulerBatchStart, schedulerBatchEnd), /resolveWorkspaceHashForRecord\(item\.workspace\)/u, "frozen candidates must not re-resolve workspace aliases");
    const recoveryHandlerStart = recordToolSource.indexOf("function ensureRecordRecoveryHandlersRegistered");
    const firstResumeStart = recordToolSource.indexOf("scheduler.resumeExecution(task.id, context", recoveryHandlerStart);
    assert.ok(recoveryHandlerStart >= 0 && firstResumeStart > recoveryHandlerStart, "scheduler recovery handler must be locatable");
    assert.doesNotMatch(recordToolSource.slice(recoveryHandlerStart, firstResumeStart), /schedulerRecoveryPayload\(task\)/u, "recovery payload parsing must not happen before resumeExecution acquires the runtime owner");

for (let attempt = 0; attempt < 400; attempt += 1) {
    const stats = getBackgroundTaskQueueStatsForTest();
    if (stats.active === 0 && stats.pending === 0) break;
    await sleep(25);
}
assert.deepEqual(
    getBackgroundTaskQueueStatsForTest(),
    { active: 0, pending: 0 },
    "production wiring test must not leave background file persistence running before temp-root cleanup",
);
__setRecordSchedulerRuntimeForTest(undefined);
sourceCache.resetConversationSourceCacheForTests();
fs.rmSync(dataRoot, { recursive: true, force: true });
console.log("record scheduler production wiring tests passed");
