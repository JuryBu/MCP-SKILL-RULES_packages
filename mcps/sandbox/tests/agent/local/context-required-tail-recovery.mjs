import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson } from '../../../src/agent-server/protocol.ts';
import { ProviderCompressionModelPort } from '../../../src/agent-server/context/server-adapter.ts';
import { validateCompressionResult } from '../../../src/agent-server/context/compaction.ts';
import { derivedContextId, hashBytes, hashContext } from '../../../src/agent-server/context/config.ts';
import { createFixture, ready } from './context-fixtures.mjs';

async function fixture({ required = true, continuation, explicit = false, invalidBody = false, journalState = 'committed' } = {}) {
    const base = createFixture({ rounds: 4 });
    const { candidate } = await ready(base);
    const original = base.model.calls.find(request => request.reason !== 'fold');
    const payload = JSON.parse(original.chunk.body);
    payload.semanticTail = { continuesPreviousRequired: required };
    payload.anchors = [];
    const body = canonicalJson(payload);
    const request = structuredClone(original);
    request.chunk.body = body;
    request.chunk.anchors = [];
    request.chunk.sourceSpans = payload.targets.map(target => target.span);
    request.chunk.chunkId = derivedContextId([candidate.candidateId, request.chunk.roundId, request.chunk.sourceSpans]);
    request.chunk.inputBodyHash = hashBytes(body);
    request.inputBodyHash = hashBytes(body);
    const snapshot = { conversationId: candidate.conversationId, runId: candidate.snapshot.runId, runEpoch: candidate.snapshot.runEpoch,
        roundId: candidate.snapshot.execution.roundId, stepId: request.stepId, actionId: request.actionId,
        historyEpoch: candidate.snapshot.historyEpoch, appendSeq: candidate.snapshot.snapshotAppendSeq,
        viewRevision: candidate.snapshot.parentViewRevision, workspaceRevision: candidate.snapshot.workspaceRevision,
        rootBudgetId: candidate.snapshot.execution.rootBudgetId, compressionCandidateId: candidate.candidateId,
        compressionRequestAttemptId: request.attemptId, compressionGeneration: candidate.snapshot.compressionGeneration,
        effectiveCompressionModelFingerprint: candidate.snapshot.effectiveModelFingerprint,
        body: canonicalJson({ messages: [{ content: body }] }) };
    snapshot.bodyHash = hashBytes(snapshot.body);
    const digest = { body: 'Known source facts.', skeleton: 'Source index.', title: 'Source', unresolved: [],
        ...(explicit ? { continuesPrevious: continuation } : {}) };
    const response = { attemptId: request.attemptId, providerResponseId: 'paid-fixture', complete: true, stop: { kind: 'completed' },
        toolCalls: [], problems: [], blocks: [{ type: 'text', thought: true, text: 'Never use this block.' },
            { type: 'text', text: invalidBody ? '{' : JSON.stringify(digest) }], usage: { inputTokens: 10, outputTokens: 5 } };
    const identity = hashContext({ attemptId: request.attemptId, actionId: request.actionId, stepId: request.stepId,
        execution: request.execution, chunkId: request.chunk.chunkId, inputBodyHash: request.inputBodyHash,
        modelFingerprint: request.snapshot.effectiveModelFingerprint, compressionGeneration: request.snapshot.compressionGeneration });
    const link = { value: { state: 'committed', attemptId: request.attemptId, providerAttemptId: request.attemptId,
        contentId: 'material', requestHash: identity } };
    const saved = { state: journalState, attempt: { attemptId: request.attemptId, rootBudgetId: snapshot.rootBudgetId, snapshot }, response };
    let dispatches = 0;
    const model = new ProviderCompressionModelPort({ store: { async getRecord() { return structuredClone(link); },
        async readContent() { return { snapshot: structuredClone(snapshot) }; } }, provider: {},
        journal: { async readAttempt() { return structuredClone(saved); } },
        dispatcher: { async execute() { dispatches++; throw new Error('New provider dispatch is forbidden'); } } });
    const initial = await model.lookup(request);
    candidate.state = 'failed';
    candidate.pendingRequest = null;
    candidate.chunks = [];
    candidate.error = { code: 'CONTEXT_SOURCE_GAP', mayHaveStarted: false, details: { knownInvalidDigest: true, attemptId: request.attemptId } };
    candidate.failedResult = { ...initial.result, complete: false, usage: { ...initial.result?.usage, digestValidation: 'semantic tail continuation' } };
    return { model, request, candidate, snapshot, saved, link, response, dispatches: () => dispatches };
}

test('required same-round continuation defaults to true without changing the provider response', async () => {
    const value = await fixture();
    const before = canonicalJson(value.response);
    const result = await value.model.lookup(value.request);
    validateCompressionResult(value.request, result.result);
    assert.equal(result.result.digest.continuesPrevious, true);
    assert.equal(canonicalJson(value.response), before);
    assert.equal(value.dispatches(), 0);
});

for (const options of [{ explicit: true, continuation: false }, { explicit: true, continuation: 'true' }, { explicit: true, continuation: null }, { required: false }]) {
    test(`rejects invalid continuation ${JSON.stringify(options)}`, async () => {
        const value = await fixture(options);
        const result = await value.model.lookup(value.request);
        assert.throws(() => validateCompressionResult(value.request, result.result), error => error.code === 'CONTEXT_SOURCE_GAP');
        assert.equal(value.dispatches(), 0);
    });
}

test('revalidates a known paid response into a source chunk with no dispatch and retains the failed candidate', async () => {
    const value = await fixture();
    const before = canonicalJson(value.candidate);
    const chunk = await value.model.recoverCommittedFailure(value.candidate);
    assert.equal(chunk.complete, true);
    assert.deepEqual(chunk.sourceSpans, value.request.chunk.sourceSpans);
    assert.equal(chunk.chunkId, value.request.chunk.chunkId);
    assert.equal(canonicalJson(value.candidate), before);
    assert.equal(value.dispatches(), 0);
    const cold = await value.model.recoverCommittedFailure(structuredClone(value.candidate));
    assert.deepEqual(cold, chunk);
});

for (const kind of ['unknown', 'identity', 'invalidbody']) {
    test(`rejects ${kind} without new dispatch`, async () => {
        const value = await fixture({ invalidBody: kind === 'invalidbody' });
        if (kind === 'unknown') value.saved.state = 'unknown';
        if (kind === 'identity') value.snapshot.compressionGeneration = 'changed';
        await assert.rejects(() => value.model.recoverCommittedFailure(value.candidate));
        assert.equal(value.dispatches(), 0);
    });
}
