import assert from 'node:assert/strict';
import test from 'node:test';
import { ContextFault, computeContextLimits } from '../../../src/agent-server/context/index.ts';
import { createFixture, estimate } from './context-fixtures.mjs';

async function pendingPublication(failure) {
    const fixture = createFixture();
    const limits = computeContextLimits(fixture.config.model.contextWindow, fixture.config.model.maxOutputTokens, fixture.config.policy);
    let finishing = false;
    const estimator = async (_snapshot, summary) => {
        if (finishing) throw failure;
        return { estimate: estimate(summary.text ? 5000 : 1000), modelId: 'fixture-model', adapterVersion: 'fixture-native-v1' };
    };
    const handle = await fixture.compactor.start({ conversationId: fixture.port.capture.conversationId, config: fixture.config,
        execution: fixture.port.capture.execution, reason: 'background', limits, estimateCompaction: estimator });
    const candidate = await handle.completion;
    assert.equal(candidate.state, 'ready');
    finishing = true;
    return { fixture, candidate };
}

test('known pre-publication background size failure releases the ended task and preserves the old view and failure', async () => {
    const failure = new ContextFault('SUMMARY_BUDGET', 'ordinary final native input grew before publication', { summaryTokens: 9001, summaryBudget: 9000 });
    const { fixture, candidate } = await pendingPublication(failure);
    const priorView = structuredClone(fixture.port.capture.view);
    const calls = fixture.model.calls.length;
    const result = await fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution,
        fixture.port.capture.stepSeq, { publishReady: true });
    assert.equal(result.state, 'released');
    assert.equal(fixture.port.commits, 0);
    assert.deepEqual(fixture.port.capture.view, priorView);
    assert.equal(fixture.model.calls.length, calls);
    const stored = fixture.port.candidates.get(candidate.candidateId);
    assert.equal(stored.state, 'discarded');
    assert.equal(stored.error.code, 'CONTEXT_SUMMARY_BUDGET');
    assert.equal(stored.error.mayHaveStarted, false);
    assert.equal(stored.pendingRequest, null);
    const state = await fixture.compactor.context(fixture.port.capture.conversationId);
    assert.equal(state.scheduler.state, 'circuitBroken');
    assert.equal(state.scheduler.lastFailure.code, 'CONTEXT_SUMMARY_BUDGET');
    assert.equal(fixture.compactor.hasLocalCompaction(fixture.port.capture.conversationId), false);
});

test('unknown publication or ordinary storage errors retain the ready candidate and cleanup uncertainty', async () => {
    for (const failure of [new ContextFault('COMMIT_UNKNOWN', 'ordinary missing transaction receipt', undefined, true),
        new Error('ordinary storage response interruption')]) {
        const { fixture, candidate } = await pendingPublication(failure);
        await assert.rejects(fixture.compactor.finishExecution(fixture.port.capture.conversationId, fixture.port.capture.execution,
            fixture.port.capture.stepSeq, { publishReady: true }));
        assert.equal(fixture.port.commits, 0);
        assert.equal(fixture.port.candidates.get(candidate.candidateId).state, 'ready');
    }
});
