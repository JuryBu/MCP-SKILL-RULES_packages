import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { MemoryStore } from '../../storage/memory.ts';
import { StoreCompactionPort } from '../../storage/context-port.ts';
import { contextCandidateKey, contextContent, contextStateKey, initialContextState } from '../../storage/context-transactions.ts';
import { createContextServerAdapter } from '../server-adapter.ts';
import { reconcileRunCleanup } from '../../cleanup-reconciliation.ts';
import { recoverRun } from '../../recovery.ts';
import { hashContext } from '../config.ts';

async function fixture({ candidateState = 'published', sourceEpoch = 1, restart = true, runPatch = {}, candidatePatch } = {}) {
    const store = new MemoryStore();
    const conversationId = randomUUID();
    const runId = randomUUID();
    const candidateId = randomUUID();
    const generation = randomUUID();
    const lease = { kind: 'task', conversationId, runId, runEpoch: sourceEpoch, rootBudgetId: runId,
        roundId: randomUUID(), stepId: randomUUID(), deadlineAt: '2099-01-01T00:00:00.000Z' };
    const original = { kind: 'task', conversationId, runId, rootRunId: runId, runEpoch: 1,
        state: restart ? 'running' : 'outcome_unknown', phase: 'awaiting_response', effectState: 'unknown', resultStatus: 'unknown',
        cleanupState: 'unconfirmed', stopReason: 'CONTEXT_ATTEMPT_UNKNOWN', ...runPatch };
    const recovered = restart ? recoverRun(original) : original;
    const request = { attemptId: randomUUID(), actionId: randomUUID(), execution: lease };
    const candidate = { candidateId, conversationId, state: candidateState,
        snapshot: { runId, runEpoch: sourceEpoch, execution: lease, historyEpoch: 1, compressionGeneration: generation },
        pendingRequest: candidateState === 'unknown' ? request : null, error: null };
    if (candidatePatch) candidatePatch(candidate);
    const record = (kind, id, value) => ({ key: { conversationId, kind, id }, revision: 1, value });
    const candidateContentId = randomUUID();
    const records = [record('conversation', conversationId, { conversationId, state: 'open', activeRunId: runId,
        historyEpoch: 1, viewRevision: 1, appendSeq: 44 }), record('run', runId, recovered),
    { key: contextStateKey(conversationId), revision: 1, value: { ...initialContextState(), execution: lease, candidateId,
        compressionGeneration: generation, viewContentId: 'original-published-view', configContentId: 'original-config' } },
    { key: contextCandidateKey(conversationId, candidateId), revision: 1,
        value: { kind: 'context_candidate', candidateId, state: candidateState, contentId: candidateContentId, contentHash: hashContext(candidate) } }];
    await store.commitTransition({ expected: records.map(entry => ({ key: entry.key, revision: null })), records,
        contents: [contextContent(conversationId, candidateContentId, 'context_candidate', candidate)] });
    const accounting = { budget: { rootBudgetId: runId, heldMicros: 432028, spentMicros: 0, amountUnknown: true },
        reservations: [{ attemptId: request.attemptId, rootBudgetId: runId, state: 'dispatched', heldMicros: 432028 }], charges: [] };
    const attempt = { state: 'dispatching', attempt: { attemptId: request.attemptId, rootBudgetId: runId,
        snapshot: { conversationId, runId, runEpoch: 1 } } };
    let modelCalls = 0;
    const forbidden = async () => { modelCalls++; assert.fail('Unknown cleanup must never dispatch, cancel or look up a model'); };
    const adapter = createContextServerAdapter({ store, provider: { ledger: { read: async () => structuredClone(accounting) } },
        journal: { readAttempt: async () => structuredClone(attempt) }, dispatcher: { execute: forbidden, lookup: forbidden } });
    const identity = { conversationId, runId, runEpoch: recovered.runEpoch, rootBudgetId: runId };
    const preserved = async () => ({ candidate: await adapter.compactionPort.getCandidate(conversationId, candidateId),
        candidateIndex: await store.getRecord(contextCandidateKey(conversationId, candidateId)), accounting: structuredClone(accounting),
        attempt: structuredClone(attempt), run: await store.getRecord({ conversationId, kind: 'run', id: runId }) });
    return { store, adapter, identity, recovered, accounting, attempt, candidate, lease, preserved, modelCalls: () => modelCalls,
        close: () => store.close() };
}

for (const candidateState of ['published', 'unknown']) {
    test(`explicit local cleanup accepts a restart-fenced original ${candidateState} candidate and preserves all unknown financial facts`, async () => {
        const owned = await fixture({ candidateState });
        try {
            assert.equal(owned.recovered.runEpoch, 2);
            assert.equal(owned.recovered.stopReason, 'RESTART_RECONCILIATION_REQUIRED');
            const before = await owned.preserved();
            const released = await reconcileRunCleanup({ snapshot: owned.recovered, conversationOptions: {}, preserveUnknownOutcome: true }, {
                readBudget: async () => structuredClone(owned.accounting), readAttempt: async () => structuredClone(owned.attempt),
                releaseTools: async () => 'released', releaseContext: () => owned.adapter.confirmUnknownCleanup(owned.identity),
            });
            assert.equal(released, 'resources_released');
            const state = await owned.store.getRecord(contextStateKey(owned.identity.conversationId));
            assert.equal(state.value.execution, null);
            assert.equal(state.value.candidateId, null);
            assert.equal(state.value.lastUnknownWaitEnd.runEpoch, 2);
            assert.deepEqual(await owned.preserved(), before);
            assert.equal(owned.modelCalls(), 0);
        } finally { await owned.close(); }
    });
}

test('same-epoch unknown acknowledgement remains compatible', async () => {
    const owned = await fixture({ restart: false, candidateState: 'unknown' });
    try { assert.equal(await owned.adapter.confirmUnknownCleanup(owned.identity), true); }
    finally { await owned.close(); }
});

for (const [name, options] of [
    ['unrelated unknown reason', { restart: false, sourceEpoch: 1, runPatch: { runEpoch: 2, stopReason: 'UNRELATED_UNKNOWN' } }],
    ['two-epoch source gap', { runPatch: { runEpoch: 2 } }],
    ['source lease newer than the original epoch', { sourceEpoch: 2 }],
    ['mismatched pending request root', { candidateState: 'unknown', candidatePatch: candidate => {
        candidate.pendingRequest.execution = { ...candidate.pendingRequest.execution, rootBudgetId: randomUUID() };
    } }],
    ['unfinished candidate', { candidateState: 'generating' }],
]) {
    test(`${name} remains blocked without changing candidate, run or accounting`, async () => {
        const owned = await fixture(options);
        try {
            const before = await owned.preserved();
            const state = await owned.store.getRecord(contextStateKey(owned.identity.conversationId));
            assert.equal(await owned.adapter.confirmUnknownCleanup(owned.identity), false);
            assert.deepEqual(await owned.store.getRecord(state.key), state);
            assert.deepEqual(await owned.preserved(), before);
            assert.equal(owned.modelCalls(), 0);
        } finally { await owned.close(); }
    });
}

test('a live local compaction prevents explicit acknowledgement even for a correctly fenced restart', async () => {
    const owned = await fixture({ candidateState: 'unknown' });
    try {
        owned.adapter.service.compactor.active.set(owned.identity.conversationId, { candidate: owned.candidate, settled: false });
        const state = await owned.store.getRecord(contextStateKey(owned.identity.conversationId));
        const before = await owned.preserved();
        assert.equal(await owned.adapter.confirmUnknownCleanup(owned.identity), false);
        assert.deepEqual(await owned.store.getRecord(state.key), state);
        assert.deepEqual(await owned.preserved(), before);
    } finally { await owned.close(); }
});

test('ordinary cleanup still refuses dispatching attempts before releasing resources', async () => {
    const owned = await fixture();
    try {
        let releaseCalls = 0;
        const before = await owned.preserved();
        assert.equal(await reconcileRunCleanup({ snapshot: owned.recovered, conversationOptions: {} }, {
            readBudget: async () => structuredClone(owned.accounting), readAttempt: async () => structuredClone(owned.attempt),
            releaseTools: async () => { releaseCalls++; return 'released'; }, releaseContext: () => owned.adapter.confirmUnknownCleanup(owned.identity),
        }), 'unconfirmed');
        assert.equal(releaseCalls, 0);
        assert.deepEqual(await owned.preserved(), before);
    } finally { await owned.close(); }
});
