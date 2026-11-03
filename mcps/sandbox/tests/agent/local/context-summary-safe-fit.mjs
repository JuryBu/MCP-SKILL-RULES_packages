import assert from 'node:assert/strict';
import test from 'node:test';
import { fitCompactionSummary } from '../../../src/agent-server/context/compaction.ts';
import { createFixture, estimate } from './context-fixtures.mjs';

async function setup(inputBudget = 1100) {
    const value = createFixture();
    const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId,
        config: value.config, execution: value.port.capture.execution, reason: 'hard' });
    const candidate = await handle.completion;
    const snapshot = { ...candidate.snapshot, requestBudget: { target: 900, inputBudget, summaryBudget: 800,
        fixedInputTokens: 100, nativeViewHash: 'fixed-native', modelId: 'ordinary-model', adapterVersion: 'ordinary-adapter' } };
    return { value, candidate, snapshot, input: { snapshot, nodes: candidate.nextView.nodes,
        coveredEndSeq: candidate.nextView.coveredEndSeq } };
}

const measured = tokens => async () => ({ estimate: estimate(tokens), nativeViewHash: 'complete-native',
    modelId: 'ordinary-model', adapterVersion: 'ordinary-adapter' });

test('unreachable optimization target accepts the fully measured minimum strictly below the hard input budget', async () => {
    const fixture = await setup();
    const nodes = structuredClone(fixture.input.nodes);
    const calls = fixture.value.model.calls.length;
    const result = await fitCompactionSummary({ ...fixture.input, estimateCompaction: measured(1000) });
    assert.equal(result.fitEvidence.inputTokens, 1000);
    assert.equal(result.fitEvidence.inputBudget, 1100);
    assert.equal(result.fitEvidence.target, 900);
    assert.equal(result.fitEvidence.targetReached, false);
    assert.equal(result.fitEvidence.optimizationStoppedAtMinimum, true);
    assert.ok(result.rendered.tokens <= result.budget);
    assert.deepEqual(fixture.input.nodes, nodes);
    assert.equal(fixture.value.model.calls.length, calls);
});

test('equal or excessive complete input stays refused after the minimum is reached', async () => {
    for (const tokens of [1100, 1101]) {
        const fixture = await setup();
        await assert.rejects(fitCompactionSummary({ ...fixture.input, estimateCompaction: measured(tokens) }),
            { code: 'CONTEXT_SUMMARY_BUDGET' });
    }
});

test('legacy or malformed hard-budget evidence cannot enable fallback', async () => {
    for (const budget of [undefined, null, NaN, Infinity, 1100.5, 899]) {
        const fixture = await setup(budget);
        fixture.snapshot.requestBudget.inputBudget = budget;
        await assert.rejects(fitCompactionSummary({ ...fixture.input, estimateCompaction: measured(1000) }),
            { code: 'CONTEXT_SUMMARY_BUDGET' });
    }
});

test('the original foreground model identity remains mandatory', async () => {
    const fixture = await setup();
    await assert.rejects(fitCompactionSummary({ ...fixture.input, estimateCompaction: async () => ({
        ...(await measured(1000)()), modelId: 'different-model' }) }), { code: 'CONTEXT_MODEL_STALE' });
});

test('minimum fallback remeasures a previously safe representation when the current tail grows', async () => {
    const fixture = await setup();
    let counts = 0;
    await assert.rejects(fitCompactionSummary({ ...fixture.input, estimateCompaction: async () => {
        counts++;
        return measured(counts === 1 ? 1000 : 1100)();
    } }), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.ok(counts > 1);
});
