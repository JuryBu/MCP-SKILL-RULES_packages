import assert from 'node:assert/strict';
import test from 'node:test';
import { computeContextLimits } from '../../../src/agent-server/context/index.ts';
import { createFixture, estimate, fixtureConfig, fixtureModel } from './context-fixtures.mjs';

function hardRequest(finalInputTokens) {
    const config = fixtureConfig({ currentModel: { ...fixtureModel, contextWindow: 16384, maxOutputTokens: 2048 } });
    const fixture = createFixture({ config });
    const limits = computeContextLimits(config.model.contextWindow, config.model.maxOutputTokens, config.policy);
    let estimates = 0;
    const input = { conversationId: fixture.port.capture.conversationId, execution: fixture.port.capture.execution,
        config, stepSeq: fixture.port.capture.stepSeq, limits,
        estimate: async () => estimate(++estimates === 1 ? 14000 : finalInputTokens),
        estimateCompaction: async (_snapshot, summary) => ({ estimate: estimate(summary.text ? 9000 : 6000),
            modelId: config.model.model, adapterVersion: config.model.adapterVersion }) };
    return { fixture, limits, input };
}

for (const finalInputTokens of [10368, 13311]) {
    test(`hard compression permits ${finalInputTokens} verified input tokens below the safe input budget even above its optimization target`, async () => {
        const { fixture, limits, input } = hardRequest(finalInputTokens);
        assert.equal(limits.target, 9830);
        assert.equal(limits.inputBudget, 13312);
        const result = await fixture.compactor.beforeRequest(input);
        assert.equal(result.inputTokens, finalInputTokens);
        assert.ok(result.inputTokens < limits.inputBudget);
        assert.equal(fixture.port.commits, 1);
        assert.ok(fixture.model.calls.length > 0);
        assert.notEqual((await fixture.compactor.context(input.conversationId)).scheduler.state, 'hardPaused');
        assert.equal(limits.contextWindow, 16384);
        assert.equal(limits.outputReserve, 2048);
        assert.equal(limits.margin, 1024);
    });
}

for (const finalInputTokens of [13312, 14000]) {
    test(`hard compression still rejects ${finalInputTokens} input tokens at or beyond the safe budget and does not regenerate the same input`, async () => {
        const { fixture, limits, input } = hardRequest(finalInputTokens);
        await assert.rejects(fixture.compactor.beforeRequest(input), { code: 'CONTEXT_SUMMARY_BUDGET' });
        const calls = fixture.model.calls.length;
        const state = await fixture.compactor.context(input.conversationId);
        assert.equal(state.scheduler.state, 'hardPaused');
        assert.equal(state.scheduler.lastFailure.details.inputBudget, limits.inputBudget);
        assert.equal(state.scheduler.lastFailure.details.inputTokens, finalInputTokens);
        assert.equal(fixture.port.commits, 1);
        await assert.rejects(fixture.compactor.beforeRequest(input), { code: 'CONTEXT_SUMMARY_BUDGET' });
        assert.equal(fixture.model.calls.length, calls);
    });
}
