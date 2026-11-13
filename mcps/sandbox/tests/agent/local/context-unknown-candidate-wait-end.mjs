import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { reconcileRunCleanup } from '../../../src/agent-server/cleanup-reconciliation.ts';
import { BudgetLedger } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { createContextServerAdapter } from '../../../src/agent-server/context/server-adapter.ts';
import { hashBytes, hashContext } from '../../../src/agent-server/context/config.ts';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { newProfile } from '../../../src/agent-server/profiles/profile-store.ts';
import { createSqliteProviderPorts } from '../../../src/agent-server/storage/provider-journal.ts';
import { contextCandidateKey, contextContent, contextStateKey } from '../../../src/agent-server/storage/context-transactions.ts';
import { estimate, fixtureConfig } from './context-fixtures.mjs';
import { computeContextLimits } from '../../../src/agent-server/context/budget.ts';
import { createAgentServices } from '../../../src/agent-server/server-services.ts';
import { MemoryCatalogPort } from '../../../src/agent-server/models/catalog.ts';

const budget = { costMode: 'hard', currency: 'USD', maxCostMicros: 100000, maxModelCalls: 4,
    maxOutputTokens: 256, wallMs: 60000 };

async function until(operation, predicate) {
    const deadline = Date.now() + 10000;
    for (;;) {
        const result = await operation();
        if (predicate(result)) return result;
        assert.ok(Date.now() < deadline, `owned candidate fixture did not settle: ${JSON.stringify(result)}`);
        await delay(10);
    }
}

export async function fixture({ candidateState = 'unknown', pending = true, settled = false, fullServices = false, startEpoch = 0, checkNextContext = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'context-unknown-candidate-wait-end-'));
    const dataDir = join(root, 'store');
    const client = { principalId: randomUUID(), clientId: randomUUID(), callerHost: 'standalone-cli' };
    const quotaLimitId = randomUUID();
    const quotaScopeId = randomUUID();
    const executions = [];
    const unexpectedCalls = [];
    const config = fixtureConfig();
    let store;
    let runtime;
    let contextService;
    let journal;
    let ledger;
    let control;
    let started;
    let startCommandId;
    let original;
    let services;

    function forbiddenCall(name) {
        return async () => { unexpectedCalls.push(name); assert.fail(`fixture attempted ${name}`); };
    }

    async function open() {
        store = fullServices
            ? await (await import('../../../dist/agent-server/storage/index.js')).openAgentStore({ dataDir })
            : await openAgentStore({ dataDir });
        const ports = createSqliteProviderPorts(store.persistent);
        journal = ports.journal;
        ledger = new BudgetLedger(ports.accountingPort);
        contextService = createContextServerAdapter({ store, provider: { ledger }, journal,
            dispatcher: { execute: forbiddenCall('provider dispatch'), lookup: forbiddenCall('provider lookup') } });
        runtime = createAgentRuntime({ store, accountingPort: ports.accountingPort,
            reconcileRunCleanup: input => services ? services.reconcileRunCleanup(input) : reconcileRunCleanup(input, {
                readBudget: rootBudgetId => ledger.read(rootBudgetId), readAttempt: attemptId => journal.readAttempt(attemptId),
                releaseTools: async () => 'not_needed',
                releaseContext: cleanup => cleanup.preserveUnknownOutcome === true
                    ? contextService.confirmUnknownCleanup({ conversationId: cleanup.snapshot.conversationId,
                        runId: cleanup.snapshot.runId, runEpoch: cleanup.snapshot.runEpoch,
                        rootBudgetId: cleanup.snapshot.rootRunId ?? cleanup.snapshot.runId })
                    : contextService.reconcileCleanup({ conversationId: cleanup.snapshot.conversationId, runId: cleanup.snapshot.runId }),
            }),
            executor: { capabilities: { hardBudget: true }, async execute(context) {
                executions.push({ runId: context.snapshot.runId, input: structuredClone(context.content) });
                const lease = { kind: context.snapshot.kind, conversationId: context.snapshot.conversationId,
                    runId: context.snapshot.runId, runEpoch: context.snapshot.runEpoch,
                    rootBudgetId: context.snapshot.rootRunId ?? context.snapshot.runId,
                    roundId: context.snapshot.activeRoundId, stepId: randomUUID(), deadlineAt: context.snapshot.deadlineAt };
                await contextService.compactionPort.bindExecution(lease, config);
                if (original) {
                    if (checkNextContext) {
                        try { await contextService.service.compactor.beforeRequest({ conversationId: lease.conversationId,
                            execution: lease, config, stepSeq: 1, limits: computeContextLimits(config.model.contextWindow, config.model.maxOutputTokens, config.policy),
                            estimate: async () => estimate(100) }); }
                        catch (error) { return { status: 'failed', cleanupState: 'not_needed', effectState: 'none', stopReason: error.code,
                            failure: { error: error.toJSON(), acceptance: 'not_sent', cleanupEvidence: 'no_resources_created' } }; }
                    }
                    return { status: 'succeeded', cleanupState: 'not_needed', result: { newRoot: lease.rootBudgetId } };
                }
                await ledger.create({ rootBudgetId: lease.rootBudgetId, mode: 'hard', currency: 'USD',
                    maxCostMicros: budget.maxCostMicros, maxModelCalls: budget.maxModelCalls,
                    maxOutputTokens: budget.maxOutputTokens, deadlineAt: lease.deadlineAt, quotaLimitId,
                    sourceRef: 'owned-offline-candidate-fixture' });
                const conversation = await store.getRecord({ conversationId: lease.conversationId,
                    kind: 'conversation', id: lease.conversationId });
                const state = await store.getRecord(contextStateKey(lease.conversationId));
                const candidateId = randomUUID();
                const compactionSnapshot = { candidateId, conversationId: lease.conversationId, runId: lease.runId,
                    runEpoch: lease.runEpoch, compressionGeneration: state.value.compressionGeneration,
                    historyEpoch: conversation.value.historyEpoch, snapshotAppendSeq: conversation.value.appendSeq,
                    parentViewRevision: conversation.value.viewRevision, startRoundId: lease.roundId, endRoundId: lease.roundId,
                    coveredStartSeq: 1, coveredEndSeq: conversation.value.appendSeq, snapshotStepSeq: 1, targetReplaceStep: 4,
                    sourceManifestHash: hashContext([]), sourcePrefixHash: hashContext([]), sourceSpans: [], parentBatchIds: [],
                    compressionProfileRevision: config.model.profileRevision, effectiveModelFingerprint: config.modelFingerprint,
                    configFingerprint: config.configFingerprint, sourceHistoryRoot: conversation.value.historyRoot,
                    workspaceRevision: conversation.value.workspaceRevision, createdAt: new Date().toISOString(),
                    manifest: { hash: hashContext([]), prefixHash: hashContext([]), blocks: [], rounds: [] },
                    referenceBlocks: [], execution: lease, config };
                const body = canonicalJson({ fixture: 'offline candidate wait cleanup', targets: [], references: [] });
                const profile = { ...newProfile({ profileId: randomUUID(), label: 'Owned offline fixture', protocol: 'compatible_chat',
                    baseUrl: 'https://offline-fixture.invalid/v1', modelId: 'owned-offline-model' }), quotaScopeId };
                const fixed = { schemaVersion: 1, frozenAt: new Date().toISOString(), rootBudgetId: lease.rootBudgetId,
                    conversationId: lease.conversationId, runId: lease.runId, runEpoch: lease.runEpoch, roundId: lease.roundId,
                    stepId: lease.stepId, actionId: randomUUID(), historyEpoch: conversation.value.historyEpoch,
                    appendSeq: conversation.value.appendSeq, viewRevision: conversation.value.viewRevision,
                    workspaceRevision: conversation.value.workspaceRevision, catalogVersion: 'owned-offline-v1',
                    capabilityVersion: 'owned-offline-v1', priceVersion: null, toolSchemaHash: hashContext([]),
                    skillVersions: {}, attachmentManifestHash: hashContext([]), nativeReplayHash: hashContext([]),
                    profile, profileRevision: profile.revision, credentialGeneration: 0, routePolicyVersion: 'owned-offline-v1',
                    modelId: 'owned-offline-model', effectiveParameters: {}, adapterVersion: 'owned-offline-v1',
                    serializerVersion: 'canonical-json-v1', endpoint: 'https://offline-fixture.invalid/v1/chat/completions',
                    body, bodyHash: hashBytes(Buffer.from(body)), timeoutMs: 1000, deadlineAt: lease.deadlineAt };
                const requestSnapshot = { ...fixed, snapshotHash: hashContext(fixed) };
                const attempt = { attemptId: randomUUID(), rootBudgetId: lease.rootBudgetId,
                    createdAt: new Date().toISOString(), snapshot: requestSnapshot };
                const upperBound = { currency: 'USD', amountMicros: 731, reliable: true,
                    source: 'fixture', sourceRef: 'owned-offline-candidate-fixture' };
                assert.equal((await journal.prepareAttempt(attempt, upperBound)).status, 'send');
                const error = { code: settled ? 'SOURCE_GAP' : 'CONTEXT_ATTEMPT_UNKNOWN',
                    message: 'Owned offline candidate retained for explicit local wait cleanup', mayHaveStarted: true, retryable: false };
                let journalPayload;
                let journalEvent;
                if (settled) {
                    journalPayload = { attemptId: attempt.attemptId, providerRequestId: 'owned-offline-request',
                        providerResponseId: randomUUID(), modelId: 'owned-offline-model', routeId: null,
                        complete: true, canExecuteTools: false, blocks: [{ type: 'text', text: 'owned settled response',
                            index: 0, candidateIndex: 0, nativeRef: 'owned-offline-text', native: { text: 'owned settled response' } }],
                        toolCalls: [], stop: { kind: 'completed' }, problems: [], usage: { providerCostCurrency: 'USD', providerCostMicros: 37 },
                        raw: { httpStatus: 200, headers: {}, body: '{"offline":true}', json: { offline: true } } };
                    await journal.commitResponse(attempt, journalPayload);
                    journalEvent = 'provider.response_committed';
                } else {
                    journalPayload = { error, acceptance: 'unknown' };
                    await journal.recordFailure(attempt, journalPayload);
                    journalEvent = 'provider.attempt_unknown';
                }
                const chunk = { chunkId: randomUUID(), roundId: lease.roundId, sourceSpans: [], referenceSpans: [],
                    anchors: [], body, inputBodyHash: fixed.bodyHash, inputTokens: 20 };
                const pendingRequest = pending ? { attemptId: attempt.attemptId, actionId: fixed.actionId, stepId: lease.stepId,
                    reason: 'hard', execution: lease, snapshot: compactionSnapshot, model: config.model, chunk,
                    maxOutputTokens: 256, inputBodyHash: fixed.bodyHash } : null;
                const candidate = { candidateId, conversationId: lease.conversationId, state: candidateState, reason: 'hard',
                    snapshot: compactionSnapshot, chunks: [], pendingRequest, failedResult: null, batch: null,
                    folds: [], nextView: null, coverage: null, error, publishedViewRevision: null, publicationReceiptKey: null };
                await contextService.compactionPort.saveCandidate(candidate);
                const current = await store.getRecord(contextStateKey(lease.conversationId));
                const checkpoint = { state: 'unknown', cooldownUntil: null, lastPublishStep: null, immediateRetriggers: 0,
                    lastFailure: error, lastPublishRevision: null, lastRetriggeredRevision: null };
                const checkpointContentId = randomUUID();
                await store.commitTransition({ expected: [{ key: current.key, revision: current.revision }],
                    records: [{ ...current, revision: current.revision + 1,
                        value: { ...current.value, checkpoint, checkpointContentId } }],
                    contents: [contextContent(lease.conversationId, checkpointContentId, 'owned_checkpoint', checkpoint)] });
                original = { identity: { conversationId: lease.conversationId, runId: lease.runId,
                    runEpoch: lease.runEpoch, rootBudgetId: lease.rootBudgetId }, candidate, attempt, error,
                    providerReceiptKey: { principalId: 'sandbox-agent-provider', clientId: 'dispatch-journal',
                        conversationId: lease.conversationId,
                        clientCommandId: `${journalEvent}:${attempt.attemptId}:${hashContext(journalPayload)}` } };
                return { status: 'outcome_unknown', cleanupState: 'unconfirmed', effectState: 'unknown', stopReason: error.code,
                    failure: { error, acceptance: settled ? 'accepted' : 'unknown', cleanupEvidence: 'unconfirmed',
                        actionId: fixed.actionId, attemptId: attempt.attemptId } };
            } } });
        if (fullServices) {
            services = await createAgentServices({ store, runtime, catalogPort: new MemoryCatalogPort(), sharedServices: [],
                authority: { dataDir: root, runtimeDir: join(root, 'runtime'), principalId: client.principalId,
                    credentialRef: 'owned-offline-full-services', secret: Buffer.alloc(32), endpoint: 'owned-offline-full-services' } });
            contextService = services.contextService;
        }
    }

    async function read() {
        return runtime.dispatch('runs.get', { conversationId: control.conversationId, runId: started.data.runId }, client);
    }

    async function preserved() {
        const candidateIndex = await store.getRecord(contextCandidateKey(control.conversationId, original.candidate.candidateId));
        return { candidateIndex, candidate: await contextService.compactionPort.getCandidate(control.conversationId, original.candidate.candidateId),
            candidateContent: await store.readContent(control.conversationId, candidateIndex.value.contentId),
            accounting: await ledger.read(original.identity.rootBudgetId), attempt: await journal.readAttempt(original.attempt.attemptId),
            startReceipt: await store.getReceipt({ ...client, conversationId: control.conversationId, clientCommandId: startCommandId }),
            providerReceipt: await store.getReceipt(original.providerReceiptKey) };
    }

    async function rewriteCandidate(transform) {
        const candidate = transform(structuredClone(await contextService.compactionPort.getCandidate(control.conversationId, original.candidate.candidateId)));
        const index = await store.getRecord(contextCandidateKey(control.conversationId, candidate.candidateId));
        const contentId = randomUUID();
        await store.commitTransition({ expected: [{ key: index.key, revision: index.revision }],
            records: [{ ...index, revision: index.revision + 1, value: { ...index.value, state: candidate.state,
                contentId, contentHash: hashContext(candidate), pendingAttemptId: candidate.pendingRequest?.attemptId ?? null } }],
            contents: [contextContent(control.conversationId, contentId, 'context_candidate', candidate)] });
    }

    async function close() {
        await services?.close();
        await runtime?.close();
        await store?.close();
        assert.equal(dirname(resolve(root)), resolve(tmpdir()));
        assert.ok(root.startsWith(join(tmpdir(), 'context-unknown-candidate-wait-end-')));
        await rm(root, { recursive: true });
    }

    try {
        await open();
        await ledger.createQuotaLimit({ quotaLimitId, currency: 'USD', maxCostMicros: 1000000,
            quotaScopeIds: [quotaScopeId], sourceRef: 'owned-offline-candidate-fixture' });
        const created = await runtime.dispatch('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' } }, client);
        assert.equal(created.ok, true, JSON.stringify(created));
        control = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
        if (startEpoch) {
            const record = await store.getRecord({ conversationId: control.conversationId, kind: 'conversation', id: control.conversationId });
            await store.commitTransition({ expected: [{ key: record.key, revision: record.revision }],
                records: [{ ...record, revision: record.revision + 1, value: { ...record.value, runEpoch: startEpoch } }] });
        }
        startCommandId = randomUUID();
        started = await runtime.dispatch('runs.start', { ...control, clientCommandId: startCommandId,
            input: { text: 'owned original offline request' }, budget: { ...budget, quotaLimitId } }, client);
        assert.equal(started.ok, true, JSON.stringify(started));
        const unknown = await until(read, value => value.data?.state === 'outcome_unknown');
        assert.ok(original, JSON.stringify(unknown));
        await delay(20);
        return { get store() { return store; }, get runtime() { return runtime; }, get contextService() { return contextService; },
            get ledger() { return ledger; }, get journal() { return journal; }, control, client, started, original, unknown,
            executions, unexpectedCalls, read, preserved, rewriteCandidate, close, get services() { return services; },
            ackParams: () => ({ ...control, clientCommandId: randomUUID(), runId: original.identity.runId,
                expectedRunEpoch: unknown.data.runEpoch, acknowledgeUnknown: true }),
            async coldOpen() { await runtime.close(); await store.close(); await open(); },
            async continue() {
                const next = await runtime.dispatch('runs.start', { ...control, clientCommandId: randomUUID(),
                    input: { text: 'owned independent new root' }, budget: { ...budget, quotaLimitId } }, client);
                assert.equal(next.ok, true, JSON.stringify(next));
                const done = await until(() => runtime.dispatch('runs.get', { conversationId: control.conversationId,
                    runId: next.data.runId }, client), value => ['succeeded', 'failed', 'outcome_unknown'].includes(value.data?.state));
                assert.equal(done.data.state, 'succeeded', JSON.stringify(done));
                return next;
            } };
    } catch (error) { await close(); throw error; }
}

async function endWait(owned, before) {
    const key = contextStateKey(owned.control.conversationId);
    const state = await owned.store.getRecord(key);
    const params = owned.ackParams();
    const ended = await owned.runtime.dispatch('runs.cancel', params, owned.client);
    assert.equal(ended.ok, true, JSON.stringify(ended));
    assert.equal(ended.data.waitEnded, true);
    assert.equal(ended.data.state, 'cancelled');
    assert.equal(ended.data.resultStatus, 'unknown');
    assert.equal(ended.data.effectState, 'unknown');
    assert.deepEqual(ended.data.failure, owned.unknown.data.failure);
    assert.deepEqual(await owned.preserved(), before);
    const after = await owned.store.getRecord(key);
    assert.equal(after.value.execution, null);
    assert.equal(after.value.candidateId, null);
    assert.equal(after.value.checkpoint, null);
    assert.equal(after.value.checkpointContentId, null);
    assert.notEqual(after.value.compressionGeneration, state.value.compressionGeneration);
    assert.equal(after.value.viewContentId, state.value.viewContentId);
    assert.equal(after.value.configContentId, state.value.configContentId);
    assert.deepEqual(after.value.lastUnknownWaitEnd, { runId: owned.original.identity.runId, runEpoch: owned.original.identity.runEpoch,
        candidateId: owned.original.candidate.candidateId, attemptId: owned.original.candidate.pendingRequest?.attemptId ?? null,
        compressionGeneration: state.value.compressionGeneration, historyEpoch: owned.original.candidate.snapshot.historyEpoch,
        at: after.value.lastUnknownWaitEnd.at });
    assert.deepEqual(await owned.runtime.dispatch('runs.cancel', params, owned.client), ended);
    assert.equal(owned.executions.length, 1);
    assert.deepEqual(owned.unexpectedCalls, []);
    return { params, ended, after };
}

for (const candidateState of ['unknown', 'failed', 'cancelled', 'discarded', 'published']) {
    test(`public acknowledgement detaches ${candidateState} candidate while retaining original financial and evidence records`, async () => {
        const owned = await fixture({ candidateState, pending: candidateState === 'unknown', settled: candidateState !== 'unknown' });
        try {
            const before = await owned.preserved();
            assert.ok(before.startReceipt);
            assert.ok(before.providerReceipt);
            if (candidateState === 'unknown') {
                assert.equal(before.accounting.budget.amountUnknown, true);
                assert.equal(before.accounting.budget.heldMicros, 731);
                assert.equal(before.attempt.state, 'unknown');
            } else {
                assert.equal(before.accounting.budget.amountUnknown, false);
                assert.equal(before.accounting.budget.heldMicros, 0);
                assert.equal(before.accounting.budget.spentMicros, 37);
                assert.equal(before.attempt.state, 'committed');
            }
            await endWait(owned, before);
        } finally { await owned.close(); }
    });
}

for (const [candidateState, pending] of [['unknown', false], ['publishing', true], ['generating', true], ['ready', true]]) {
    test(`public acknowledgement retains ${candidateState} candidate with pending=${pending} when cleanup is ineligible`, async () => {
        const owned = await fixture({ candidateState, pending });
        try {
            const before = await owned.preserved();
            const state = await owned.store.getRecord(contextStateKey(owned.control.conversationId));
            const refused = await owned.runtime.dispatch('runs.cancel', owned.ackParams(), owned.client);
            assert.equal(refused.ok, false, JSON.stringify(refused));
            assert.equal(refused.error.code, 'CLEANUP_UNCONFIRMED');
            assert.equal((await owned.read()).data.state, 'outcome_unknown');
            assert.deepEqual(await owned.store.getRecord(state.key), state);
            assert.deepEqual(await owned.preserved(), before);
            assert.deepEqual(owned.unexpectedCalls, []);
        } finally { await owned.close(); }
    });
}

test('cleanup checks owned CID, run, epoch and root without mutating the retained candidate or financial facts', async () => {
    const owned = await fixture();
    try {
        const before = await owned.preserved();
        const state = await owned.store.getRecord(contextStateKey(owned.control.conversationId));
        for (const patch of [{ conversationId: randomUUID() }, { runId: randomUUID() },
            { runEpoch: owned.original.identity.runEpoch + 1 }, { rootBudgetId: randomUUID() }]) {
            assert.equal(await owned.contextService.confirmUnknownCleanup({ ...owned.original.identity, ...patch }), false);
            assert.deepEqual(await owned.store.getRecord(state.key), state);
            assert.deepEqual(await owned.preserved(), before);
        }
    } finally { await owned.close(); }
});

for (const anchor of ['snapshotEpoch', 'snapshotRoot', 'historyEpoch', 'generation', 'pendingEpoch', 'pendingRoot']) {
    test(`retained candidate with stale ${anchor} does not authorize local wait cleanup`, async () => {
        const owned = await fixture();
        try {
            await owned.rewriteCandidate(candidate => {
                if (anchor === 'snapshotEpoch') candidate.snapshot.runEpoch++;
                if (anchor === 'snapshotRoot') candidate.snapshot.execution.rootBudgetId = randomUUID();
                if (anchor === 'historyEpoch') candidate.snapshot.historyEpoch++;
                if (anchor === 'generation') candidate.snapshot.compressionGeneration = randomUUID();
                if (anchor === 'pendingEpoch') candidate.pendingRequest.execution.runEpoch++;
                if (anchor === 'pendingRoot') candidate.pendingRequest.execution.rootBudgetId = randomUUID();
                return candidate;
            });
            const before = await owned.preserved();
            const state = await owned.store.getRecord(contextStateKey(owned.control.conversationId));
            assert.equal(await owned.contextService.confirmUnknownCleanup(owned.original.identity), false);
            assert.deepEqual(await owned.store.getRecord(state.key), state);
            assert.deepEqual(await owned.preserved(), before);
        } finally { await owned.close(); }
    });
}

test('same SQLite cold reopen preserves unknown candidate; explicit end binds the next root to a new generation without resending', async () => {
    const owned = await fixture();
    try {
        const before = await owned.preserved();
        const prior = await owned.store.getRecord(contextStateKey(owned.control.conversationId));
        await owned.coldOpen();
        assert.equal((await owned.read()).data.state, 'outcome_unknown');
        assert.deepEqual(await owned.preserved(), before);
        assert.deepEqual(await owned.store.getRecord(prior.key), prior);
        assert.equal(owned.executions.length, 1);
        const { params, ended, after } = await endWait(owned, before);
        await owned.coldOpen();
        assert.deepEqual(await owned.store.getRecord(after.key), after);
        assert.deepEqual(await owned.runtime.dispatch('runs.cancel', params, owned.client), ended);
        const next = await owned.continue();
        assert.notEqual(next.data.runId, owned.original.identity.runId);
        const bound = await owned.store.getRecord(after.key);
        assert.equal(bound.value.compressionGeneration, after.value.compressionGeneration);
        assert.equal(bound.value.execution.runId, next.data.runId);
        assert.equal(bound.value.execution.rootBudgetId, next.data.runId);
        assert.equal(bound.value.candidateId, null);
        const current = await owned.preserved();
        for (const field of ['candidateIndex', 'candidate', 'candidateContent', 'attempt', 'startReceipt', 'providerReceipt']) {
            assert.deepEqual(current[field], before[field]);
        }
        for (const field of ['budget', 'reservations', 'charges']) assert.deepEqual(current.accounting[field], before.accounting[field]);
        assert.equal(current.accounting.quotaLimit.heldMicros, before.accounting.quotaLimit.heldMicros);
        assert.deepEqual(owned.executions.map(entry => entry.input.text), ['owned original offline request', 'owned independent new root']);
        assert.deepEqual(owned.unexpectedCalls, []);
        console.log(JSON.stringify({ scope: 'source-runtime-context-sqlite-offline-fixture', coldReopens: 2,
            originalCandidateState: current.candidate.state, originalHeldMicros: current.accounting.budget.heldMicros,
            originalRequestReexecutions: 0, newRootBoundToNewGeneration: true, externalRequests: 0, providerDispatches: 0 }));
    } finally { await owned.close(); }
});
