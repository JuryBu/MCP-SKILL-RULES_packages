import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { ProviderCompressionModelPort } from '../../../src/agent-server/context/server-adapter.ts';
import { validateCompressionResult } from '../../../src/agent-server/context/compaction.ts';
import { computeContextLimits, sealSummaryNode } from '../../../src/agent-server/context/index.ts';
import { createFixture, estimate } from './context-fixtures.mjs';

const adapter = new ProviderCompressionModelPort({});
function invalidResult(request, committed = true, patch = {}) {
    const target = JSON.parse(request.chunk.body).targets[0];
    return adapter.result(request, { attemptId: request.attemptId, complete: true, stop: { kind: 'completed' },
        toolCalls: [], problems: [], blocks: [{ type: 'text', text: JSON.stringify({ body: 'ordinary invalid digest',
            title: 'fixture', skeleton: 'fixture', unresolved: [{ quote: 'missing fixture quote',
                source: { itemId: target.span.itemId, blockId: target.span.blockId } }] }) }], ...patch }, { bodyHash: 'fixture' }, committed);
}

test('offline real failedResult keeps its source failure but is known complete', async () => {
    if (!process.env.KNOWN_INVALID_CANDIDATE) return;
    const candidate = JSON.parse(await readFile(process.env.KNOWN_INVALID_CANDIDATE, 'utf8'));
    const result = candidate.failedResult;
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.pendingRequest, null);
    assert.equal(candidate.chunks.length, 3);
    assert.equal(result.usage.reason, 'fold');
    assert.equal(result.usage.digestValidation, 'unresolved source ambiguous');
    assert.ok(candidate.validationRepair);
    const request = { attemptId: result.requestAttemptId, snapshot: candidate.snapshot,
        chunk: { inputBodyHash: result.inputBodyHash, sourceSpans: result.coverage.map(entry => entry.span) } };
    assert.throws(() => validateCompressionResult(request, result), error => error.code === 'CONTEXT_SOURCE_GAP'
        && error.mayHaveStarted === false && error.details.knownInvalidDigest === true);
    console.log(JSON.stringify({ candidateId: candidate.candidateId, attemptId: result.attemptId, reason: result.usage.reason,
        chunks: candidate.chunks.length, providerComplete: result.usage.providerComplete, providerStop: result.usage.providerStop,
        validationRepairEligible: result.usage.validationRepairEligible, apiRequests: 0 }));
});

test('original fold text accepts only presentation fields and grants no requirement authority', async () => {
    if (!process.env.KNOWN_INVALID_CANDIDATE) return;
    const candidate = JSON.parse(await readFile(process.env.KNOWN_INVALID_CANDIDATE, 'utf8'));
    const failed = candidate.failedResult;
    const request = { reason: 'fold', attemptId: failed.requestAttemptId, snapshot: candidate.snapshot,
        chunk: { inputBodyHash: failed.inputBodyHash, sourceSpans: failed.coverage.map(entry => entry.span) } };
    const response = { attemptId: failed.attemptId, complete: true, stop: { kind: 'completed' }, toolCalls: [], problems: [],
        blocks: [{ type: 'text', text: failed.digest.body }] };
    const result = adapter.result(request, response, { bodyHash: failed.usage.bodyHash }, true);
    assert.equal(result.complete, true);
    assert.equal(result.digest.body, JSON.parse(failed.digest.body).body);
    assert.deepEqual(result.digest.unresolved, []);
    assert.equal(result.digest.resolutions, undefined);
});

test('real batch requirement records and completed resolutions survive a fold with original failed provider text', async () => {
    if (!process.env.KNOWN_INVALID_CANDIDATE) return;
    const original = JSON.parse(await readFile(process.env.KNOWN_INVALID_CANDIDATE, 'utf8'));
    const value = createFixture({ rounds: 30, active: false });
    const nodes = Array.from({ length: 25 }, (_, index) => sealSummaryNode({ kind: 'batch', nodeId: `fold-child-${index}`,
        firstSeq: index * 2 + 1, lastSeq: index * 2 + 2, roundIds: [`round-${index + 1}`], sourceSpans: [],
        chunkIds: [], parentBatchIds: [], modelFingerprint: 'fixture', anchors: [], body: `ordinary child ${index}`,
        skeleton: 'child', title: 'child', unresolved: index === 3 ? original.batch.unresolved : [] }));
    value.port.capture.view = { revision: 1, historyEpoch: 1, coveredEndSeq: 50, nodes };
    value.port.capture.viewRevision = 1;
    value.model.onGenerate = async (request, _signal, result) => request.reason !== 'fold' ? result : adapter.result(request,
        { attemptId: request.attemptId, complete: true, stop: { kind: 'completed' }, toolCalls: [], problems: [],
            blocks: [{ type: 'text', text: original.failedResult.digest.body }] }, { bodyHash: 'fixture' }, true);
    const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId, config: value.config,
        execution: value.port.capture.execution, reason: 'background' });
    const candidate = await handle.completion;
    assert.equal(candidate.state, 'ready');
    assert.equal(candidate.validationRepair, undefined);
    const fold = candidate.folds[0];
    assert.deepEqual(fold.unresolved, original.batch.unresolved);
    for (const child of fold.children) assert.equal(child.hash, nodes.find(node => node.nodeId === child.nodeId).hash);
    assert.ok(original.batch.unresolved.some(record => record.resolvedBy?.length));
    console.log(JSON.stringify({ inheritedOriginalBatchRecords: fold.unresolved.length,
        resolvedRecords: fold.unresolved.filter(record => record.resolvedBy?.length).length, children: fold.children.length, apiRequests: 0 }));
});

test('background known invalid stops after the single repair, preserves old view and permits fully estimated safe input', async () => {
    const value = createFixture();
    value.model.onGenerate = async request => invalidResult(request);
    const oldView = structuredClone(value.port.capture.view);
    const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId,
        config: value.config, execution: value.port.capture.execution, reason: 'background' });
    const candidate = await handle.completion;
    assert.equal(value.model.calls.length, 2);
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.pendingRequest, null);
    assert.equal(candidate.error.details.knownInvalidDigest, true);
    assert.equal(value.compactor.hasLocalCompaction(candidate.conversationId), false);
    assert.equal(value.port.commits, 0);
    assert.deepEqual(value.port.capture.view, oldView);
    assert.equal((await value.compactor.context(candidate.conversationId)).scheduler.state, 'circuitBroken');
    const limits = computeContextLimits(value.config.model.contextWindow, value.config.model.maxOutputTokens, value.config.policy);
    let estimates = 0;
    const input = { conversationId: candidate.conversationId, config: value.config, execution: value.port.capture.execution,
        stepSeq: value.port.capture.stepSeq, limits, estimate: async () => { estimates++; return estimate(100); } };
    assert.equal((await value.compactor.beforeRequest(input)).inputTokens, 100);
    assert.equal(estimates, 1);
    assert.equal(value.model.calls.length, 2);
    value.model.onGenerate = null;
    await assert.rejects(value.compactor.beforeRequest({ ...input, estimate: async () => estimate(limits.inputBudget) }),
        { code: 'CONTEXT_SUMMARY_BUDGET' });
    const calls = value.model.calls.length;
    await assert.rejects(value.compactor.beforeRequest(input), { code: 'CONTEXT_SUMMARY_BUDGET' });
    assert.equal(value.model.calls.length, calls);
});

test('incomplete, uncommitted, refusal, cancellation and wrong request binding retain uncertainty', async () => {
    for (const scenario of ['incomplete', 'uncommitted', 'refusal', 'cancelled', 'wrongBinding']) {
        const value = createFixture();
        value.model.onGenerate = async request => {
            const patch = scenario === 'incomplete' ? { complete: false } : scenario === 'cancelled' ? { stop: { kind: 'cancelled' } }
                : scenario === 'refusal' ? { blocks: [{ type: 'refusal', text: 'ordinary fixture refusal' }] } : {};
            const result = invalidResult(request, scenario !== 'uncommitted', patch);
            if (scenario === 'wrongBinding') result.requestAttemptId = 'different-request';
            return result;
        };
        const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId,
            config: value.config, execution: value.port.capture.execution, reason: 'background' });
        await assert.rejects(handle.completion, error => error.mayHaveStarted === true);
        assert.equal(value.model.calls.length, 1);
        assert.equal((await value.compactor.context(value.port.capture.conversationId)).scheduler.state, 'hardPaused');
    }
});

test('model JSON cannot supply adapter completion proof', async () => {
    const value = createFixture();
    value.model.onGenerate = async request => adapter.result(request, { attemptId: request.attemptId, complete: false,
        stop: { kind: 'completed' }, toolCalls: [], problems: [], blocks: [{ type: 'text', text: JSON.stringify({
            body: 'fixture', title: 'fixture', skeleton: 'fixture', unresolved: null,
            usage: { validationRepairEligible: true, providerComplete: true, providerStop: 'completed' }, knownInvalidDigest: true }) }] },
        { bodyHash: 'fixture' }, true);
    const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId,
        config: value.config, execution: value.port.capture.execution, reason: 'background' });
    await assert.rejects(handle.completion, error => error.mayHaveStarted === true);
    assert.equal(value.model.calls.length, 1);
});

test('committed truncated compression is a known failure without validation retry', async () => {
    const value = createFixture();
    value.model.onGenerate = async request => invalidResult(request, true, { stop: { kind: 'truncated' } });
    const oldView = structuredClone(value.port.capture.view);
    const handle = await value.compactor.start({ conversationId: value.port.capture.conversationId,
        config: value.config, execution: value.port.capture.execution, reason: 'background' });
    const candidate = await handle.completion;
    assert.equal(value.model.calls.length, 1);
    assert.equal(candidate.state, 'failed');
    assert.equal(candidate.pendingRequest, null);
    assert.equal(candidate.error.mayHaveStarted, false);
    assert.equal(candidate.error.details.knownInvalidDigest, true);
    assert.equal(candidate.error.details.compressionOutputTruncated, true);
    assert.match(candidate.error.message, /输出上限.*截断/);
    assert.equal(candidate.validationRepair, undefined);
    assert.equal(value.port.commits, 0);
    assert.deepEqual(value.port.capture.view, oldView);
    assert.equal((await value.compactor.context(candidate.conversationId)).scheduler.state, 'circuitBroken');
    for (const committed of [false]) {
        const input = createFixture();
        input.model.onGenerate = async request => invalidResult(request, committed, { stop: { kind: 'truncated' } });
        const pending = await input.compactor.start({ conversationId: input.port.capture.conversationId,
            config: input.config, execution: input.port.capture.execution, reason: 'background' });
        await assert.rejects(pending.completion, error => error.mayHaveStarted === true);
        assert.equal(input.model.calls.length, 1);
    }
});
