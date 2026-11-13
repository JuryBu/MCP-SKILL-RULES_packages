import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../../../tests/agent/local/context-unknown-candidate-wait-end.mjs';
import { hashContext } from '../config.ts';
import { contextStateKey } from '../../storage/context-transactions.ts';
import { setTimeout as delay } from 'node:timers/promises';

for (const drained of [false, true]) test(`${drained ? 'released server drain' : 'paused same-root'} old and current unknown attempts end through the complete default services acknowledgement without financial changes`, async () => {
    const owned = await fixture({ fullServices: true, startEpoch: 5, checkNextContext: drained });
    try {
        assert.equal(owned.original.identity.runEpoch, 6);
        const older = structuredClone(owned.original.attempt);
        older.attemptId = randomUUID();
        older.snapshot = { ...older.snapshot, runEpoch: 4, actionId: randomUUID() };
        delete older.snapshot.snapshotHash;
        older.snapshot.snapshotHash = hashContext(older.snapshot);
        const historicalRunKey = { conversationId: owned.control.conversationId, kind: 'run', id: owned.original.identity.runId };
        const historicalRun = await owned.store.getRecord(historicalRunKey);
        await owned.store.commitTransition({ expected: [{ key: historicalRunKey, revision: historicalRun.revision }],
            records: [{ ...historicalRun, revision: historicalRun.revision + 1,
                value: { ...historicalRun.value, state: 'running', runEpoch: 4 } }] });
        assert.equal((await owned.journal.prepareAttempt(older, { currency: 'USD', amountMicros: 997, reliable: true,
            source: 'fixture', sourceRef: 'owned-prior-resume-unknown' })).status, 'send');
        await owned.journal.recordFailure(older, { acceptance: 'unknown', error: { code: 'E_RESULT_UNKNOWN',
            message: 'Retained original epoch-four uncertainty', mayHaveStarted: true, retryable: false } });
        const runKey = { conversationId: owned.control.conversationId, kind: 'run', id: owned.original.identity.runId };
        const conversationKey = { conversationId: owned.control.conversationId, kind: 'conversation', id: owned.control.conversationId };
        const run = await owned.store.getRecord(runKey);
        const conversation = await owned.store.getRecord(conversationKey);
        await owned.store.commitTransition({ expected: [{ key: runKey, revision: run.revision }, { key: conversationKey, revision: conversation.revision }],
            records: [{ ...run, revision: run.revision + 1, value: { ...run.value, state: 'paused', runEpoch: 7,
                stopTarget: 'paused', stopReason: 'Owned acceptance call/time allocation reached; preserve current work',
                cleanupState: 'unconfirmed', internalOwnCleanupState: 'unconfirmed', effectState: 'unknown', resultStatus: 'unknown' } },
            { ...conversation, revision: conversation.revision + 1, value: { ...conversation.value, runEpoch: 7 } }] });
        if (drained) {
            const pausedRun = await owned.store.getRecord(runKey);
            const pausedConversation = await owned.store.getRecord(conversationKey);
            await owned.store.commitTransition({ expected: [{ key: runKey, revision: pausedRun.revision }, { key: conversationKey, revision: pausedConversation.revision }],
                records: [{ ...pausedRun, revision: pausedRun.revision + 1, value: { ...pausedRun.value, state: 'cancelled', runEpoch: 8,
                    stopTarget: 'cancelled', stopReason: 'SERVER_CLOSED', cleanupState: 'released', internalOwnCleanupState: 'released' } },
                { ...pausedConversation, revision: pausedConversation.revision + 1, value: { ...pausedConversation.value, activeRunId: null, runEpoch: 8 } }] });
            await owned.contextService.compactionPort.saveScheduler(owned.control.conversationId, { state: 'hardPaused', cooldownUntil: null,
                lastPublishStep: null, immediateRetriggers: 0, lastFailure: owned.original.error, lastPublishRevision: null, lastRetriggeredRevision: null });
            const blocked = await owned.runtime.dispatch('runs.start', { ...owned.control, clientCommandId: randomUUID(),
                input: { text: 'Explicit new task before old candidate detachment' },
                budget: { costMode: 'estimated', maxModelCalls: 2, maxOutputTokens: 64, wallMs: 60000 } }, owned.client);
            assert.equal(blocked.ok, true, JSON.stringify(blocked));
            let failed;
            for (let ordinal = 0; ordinal < 200; ordinal++) {
                failed = await owned.services.dispatch('runs.get', { conversationId: owned.control.conversationId, runId: blocked.data.runId }, owned.client);
                if (failed.data.state === 'failed') break;
                await delay(5);
            }
            assert.equal(failed.data.stopReason, 'CONTEXT_ATTEMPT_UNKNOWN');
            await delay(20);
        }
        const before = await owned.preserved();
        const olderBefore = await owned.journal.readAttempt(older.attemptId);
        const result = await owned.services.dispatch('runs.cancel', { ...owned.control, clientCommandId: randomUUID(),
            runId: owned.original.identity.runId, expectedRunEpoch: drained ? 8 : 7, acknowledgeUnknown: true }, owned.client);
        assert.equal(result.ok, true, JSON.stringify(result));
        assert.equal(result.data.waitEnded, true);
        assert.equal(result.data.resultStatus, 'unknown');
        assert.equal(result.data.effectState, 'unknown');
        assert.equal(result.data.cleanupState, 'released');
        assert.equal(result.data.runEpoch, drained ? 9 : 8);
        assert.deepEqual(await owned.preserved(), { ...before, accounting: before.accounting });
        assert.deepEqual(await owned.journal.readAttempt(older.attemptId), olderBefore);
        assert.deepEqual(owned.unexpectedCalls, []);
        if (drained) {
            const state = await owned.store.getRecord(contextStateKey(owned.control.conversationId));
            assert.equal(state.value.candidateId, null);
            assert.equal(state.value.checkpointContentId, null);
            await owned.continue();
            assert.deepEqual((await owned.preserved()).accounting, before.accounting);
            assert.deepEqual(await owned.journal.readAttempt(older.attemptId), olderBefore);
        }
    } finally { await owned.close(); }
});
