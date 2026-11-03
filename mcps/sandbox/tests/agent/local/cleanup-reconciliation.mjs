import assert from 'node:assert/strict';
import test from 'node:test';
import { reconcileRunCleanup } from '../../../src/agent-server/cleanup-reconciliation.ts';

const input = { snapshot: { conversationId: 'own-conversation', runId: 'own-run', rootRunId: 'own-run' }, conversationOptions: {} };
const reservation = { attemptId: 'own-attempt', state: 'unsettled', callHeld: false, heldMicros: 73 };
function ports(overrides = {}) {
    return { readBudget: async () => ({ budget: { rootBudgetId: 'own-run' }, reservations: [reservation] }),
        readAttempt: async () => ({ state: 'committed', attempt: { rootBudgetId: 'own-run', snapshot: { conversationId: 'own-conversation' } }, response: { complete: true } }),
        releaseTools: async () => 'not_needed', releaseContext: async () => true, ...overrides };
}

test('complete original response permits resource cleanup while monetary hold stays untouched', async () => {
    const before = structuredClone(reservation);
    assert.equal(await reconcileRunCleanup(input, ports()), 'resources_released');
    assert.deepEqual(reservation, before);
});

test('unknown acceptance preserves the original run before any resource release', async () => {
    let releaseCalls = 0;
    const result = await reconcileRunCleanup(input, ports({ readBudget: async () => ({ budget: { rootBudgetId: 'own-run' },
        reservations: [{ ...reservation, state: 'unknown' }] }), releaseTools: async () => { releaseCalls++; return 'released'; } }));
    assert.equal(result, 'unconfirmed');
    assert.equal(releaseCalls, 0);
});

test('incomplete response, wrong owner or unreleased tools each retain cleanup uncertainty', async () => {
    const variants = [
        { readAttempt: async () => ({ state: 'committed', attempt: { rootBudgetId: 'own-run', snapshot: { conversationId: 'own-conversation' } }, response: { complete: false } }) },
        { readAttempt: async () => ({ state: 'committed', attempt: { rootBudgetId: 'other-run', snapshot: { conversationId: 'own-conversation' } }, response: { complete: true } }) },
        { releaseTools: async () => 'unconfirmed' },
        { releaseContext: async () => false }
    ];
    for (const variant of variants) assert.equal(await reconcileRunCleanup(input, ports(variant)), 'unconfirmed');
});

const stoppedInput = { snapshot: { ...input.snapshot, kind: 'task', state: 'cancelled', cleanupState: 'unconfirmed',
    stopTarget: 'cancelled', stopReason: 'BUDGET_EXCEEDED', resultStatus: 'cancelled', effectState: 'none', runEpoch: 8 },
    conversationOptions: {}, preserveUnknownOutcome: true };
function stoppedPorts(overrides = {}) {
    return ports({ readBudget: async () => ({ budget: { rootBudgetId: 'own-run', amountUnknown: true },
        reservations: [{ ...reservation, rootBudgetId: 'own-run', state: 'unknown', dispatched: true }] }),
        readAttempt: async () => ({ state: 'unknown', attempt: { rootBudgetId: 'own-run',
            snapshot: { conversationId: 'own-conversation', runId: 'own-run', runEpoch: 7 } }, failure: { acceptance: 'accepted' } }), ...overrides });
}

test('single stopped epoch with a bound unknown original attempt can release only local resources without accounting writes', async () => {
    const original = structuredClone(stoppedInput);
    assert.equal(await reconcileRunCleanup(stoppedInput, stoppedPorts()), 'resources_released');
    assert.deepEqual(stoppedInput, original);
});

test('stopped unknown compatibility rejects unrelated stops, roots, epochs and unsent or unbound attempts before release', async () => {
    let releases = 0;
    for (const patch of [{ kind: 'maintenance' }, { state: 'running' }, { cleanupState: 'released' }, { stopTarget: null },
        { stopReason: 'UNRELATED_STOP' }, { rootRunId: 'other-root' }, { runEpoch: 9 }, { conversationId: 'other-conversation' }, { runId: 'other-run' }]) {
        assert.equal(await reconcileRunCleanup({ ...stoppedInput, snapshot: { ...stoppedInput.snapshot, ...patch } },
            stoppedPorts({ releaseTools: async () => { releases++; return 'released'; } })), 'unconfirmed');
    }
    for (const variant of [
        { readBudget: async () => ({ budget: { rootBudgetId: 'other-root', amountUnknown: true }, reservations: [] }) },
        { readBudget: async () => ({ budget: { rootBudgetId: 'own-run', amountUnknown: false }, reservations: [] }) },
        { readBudget: async () => ({ budget: { rootBudgetId: 'own-run', amountUnknown: true }, reservations: [{ ...reservation, state: 'dispatched' }] }) },
        { readAttempt: async () => ({ state: 'committed', attempt: { rootBudgetId: 'own-run', snapshot: { conversationId: 'own-conversation', runId: 'own-run', runEpoch: 7 } } }) },
        { readAttempt: async () => ({ state: 'unknown', attempt: { rootBudgetId: 'other-root', snapshot: { conversationId: 'own-conversation', runId: 'own-run', runEpoch: 7 } }, failure: { acceptance: 'accepted' } }) },
        { readAttempt: async () => ({ state: 'unknown', attempt: { rootBudgetId: 'own-run', snapshot: { conversationId: 'own-conversation', runId: 'own-run', runEpoch: 7 } }, failure: { acceptance: 'not_sent' } }) },
    ]) assert.equal(await reconcileRunCleanup(stoppedInput, stoppedPorts({ ...variant,
        releaseTools: async () => { releases++; return 'released'; } })), 'unconfirmed');
    assert.equal(releases, 0);
});
