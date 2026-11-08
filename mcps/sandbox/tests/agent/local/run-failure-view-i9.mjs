import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileRunFailureView } from '../../../dist/agent-server/run-failure-view.js';

const original = () => ({ ok: true, data: { conversationId: 'owned-view-cid', runId: 'owned-view-run', rootRunId: 'owned-view-run',
    state: 'failed', failure: { acceptance: 'not_sent', attemptId: 'owned-view-attempt',
        error: { code: 'MEDIA_CODEC_LIMIT', message: 'original limit error', mayHaveStarted: false, retryable: false, details: { maxBytes: 33554432 } } } } });
const budget = state => ({ budget: { rootBudgetId: 'owned-view-run' },
    reservations: [{ attemptId: 'owned-view-attempt', dispatched: true, state, heldMicros: 100 }], charges: [] });
const attempt = state => ({ state, attempt: { rootBudgetId: 'owned-view-run', snapshot: { conversationId: 'owned-view-cid', runId: 'owned-view-run' } } });

test('a legacy not-sent view shows original unresolved dispatch evidence without mutating history or finance', async () => {
    const snapshot = original(), before = structuredClone(snapshot), finance = budget('dispatched');
    const result = await reconcileRunFailureView(snapshot, { readBudget: async () => finance, readAttempt: async () => attempt('dispatching') });
    assert.deepEqual(snapshot, before);
    assert.equal(result.data.state, 'failed');
    assert.equal(result.data.failure.acceptance, 'unknown');
    assert.equal(result.data.failure.error.mayHaveStarted, true);
    assert.equal(result.data.failure.error.code, 'MEDIA_CODEC_LIMIT');
    assert.equal(result.data.failure.error.details.maxBytes, 33554432);
    assert.deepEqual(result.data.failure.error.details.dispatchReconciliation, { source: 'persisted_provider_attempt',
        originalAcceptance: 'not_sent', originalMayHaveStarted: false, dispatched: true, journalState: 'dispatching', reservationState: 'dispatched' });
    assert.equal(finance.reservations[0].heldMicros, 100);
    assert.equal(finance.charges.length, 0);
});

test('confirmed preflight rejection, unrelated identity and ordinary errors keep their original view', async () => {
    for (const state of ['rejected', 'settled', 'reserved']) {
        const snapshot = original();
        assert.equal(await reconcileRunFailureView(snapshot, { readBudget: async () => budget(state),
            readAttempt: async () => assert.fail('a resolved reservation should not query provider content') }), snapshot);
    }
    const snapshot = original();
    for (const recorded of [attempt('rejected'), { ...attempt('dispatching'), attempt: { rootBudgetId: 'foreign-root',
        snapshot: { conversationId: 'foreign-cid', runId: 'foreign-run' } } }]) {
        assert.equal(await reconcileRunFailureView(snapshot, { readBudget: async () => budget('dispatched'), readAttempt: async () => recorded }), snapshot);
    }
    const failure = { ok: false, error: { code: 'NOT_FOUND' } };
    assert.equal(await reconcileRunFailureView(failure, { readBudget: async () => assert.fail('error passthrough'),
        readAttempt: async () => assert.fail('error passthrough') }), failure);
});
