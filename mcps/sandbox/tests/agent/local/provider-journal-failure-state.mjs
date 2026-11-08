import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { AgentFault } from '../../../dist/agent-server/protocol.js';
import { CompatibleChatAdapter, ProviderDispatcher, ProviderFault, freezeRequest } from '../../../dist/agent-server/providers/index.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';
import { BudgetLedger, MemoryAccountingPort } from '../../../dist/agent-server/accounting/budget-ledger.js';

async function fixture(kind) {
    const rootBudgetId = `journal-failure-${kind}`;
    const ledger = new BudgetLedger(new MemoryAccountingPort());
    const deadlineAt = new Date(Date.now() + 60_000).toISOString();
    const profile = { ...newProfile({ profileId: 'journal-state-profile', label: 'owned journal fixture', protocol: 'compatible_chat',
        baseUrl: 'http://127.0.0.1:39999/v1', modelId: 'fixture-chat' }), quotaScopeId: 'journal-state-account' };
    await ledger.createQuotaLimit({ quotaLimitId: 'journal-state-global', currency: 'USD', maxCostMicros: 1000,
        quotaScopeIds: [profile.quotaScopeId], sourceRef: 'verified_fixture' });
    await ledger.create({ rootBudgetId, quotaLimitId: 'journal-state-global', currency: 'USD', maxCostMicros: 1000,
        maxModelCalls: 3, maxOutputTokens: 16, deadlineAt, sourceRef: 'verified_fixture' });
    const adapter = new CompatibleChatAdapter();
    const snapshot = freezeRequest({ adapter, profile, modelId: 'fixture-chat', rootBudgetId,
        view: { protocol: 'compatible_chat', messages: [{ role: 'user', content: 'ordinary journal persistence fixture' }] },
        parameters: { max_tokens: 16 }, deadlineAt,
        versions: { conversationId: 'journal-state-cid', runId: 'journal-state-run', roundId: null, stepId: 'journal-state-step',
            actionId: 'journal-state-action', runEpoch: 1, historyEpoch: 0, appendSeq: 1, viewRevision: 1, workspaceRevision: 0,
            catalogVersion: 'fixture', capabilityVersion: 'fixture', priceVersion: null, toolSchemaHash: 'fixture', skillVersions: {},
            attachmentManifestHash: 'fixture', nativeReplayHash: 'fixture' } });
    let networkCalls = 0;
    let failureCalls = 0;
    let saved;
    const body = JSON.stringify({ id: 'fixture-original-response', model: 'fixture-chat',
        choices: [{ index: 0, message: { role: 'assistant', content: 'original response' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
    const dispatcher = new ProviderDispatcher({ transport: { async request() { networkCalls++;
        if (kind === 'transport') throw new ProviderFault('E_RESULT_UNKNOWN', 'fixture accepted stream failed',
            { acceptance: 'accepted', rawResponse: { httpStatus: 200, headers: {}, body, json: {} } });
        return { status: 200, headers: {}, body };
    } }, journal: {
        async prepareAttempt(attempt, upperBound) {
            await ledger.reserve({ rootBudgetId, attemptId: attempt.attemptId, actionId: snapshot.actionId, quotaScopeId: profile.quotaScopeId,
                snapshotHash: snapshot.snapshotHash, upperBound });
            await ledger.dispatched(attempt.attemptId);
            return { status: 'send' };
        },
        async commitResponse() { throw new AgentFault('MEDIA_CODEC_LIMIT', 'fixture response representation too large'); },
        async recordFailure(attempt, failure) {
            failureCalls++;
            if (kind === 'unavailable') throw new AgentFault('STORAGE_DURABILITY_FAILED', 'fixture journal unavailable');
            if (failure.rawResponse) throw new AgentFault('MEDIA_CODEC_LIMIT', 'fixture raw representation too large');
            saved = failure;
            await ledger.unknown(attempt.attemptId);
        },
    } });
    return { run: () => dispatcher.execute(adapter, snapshot, rootBudgetId,
        { amountMicros: 100, currency: 'USD', reliable: true, source: 'fixture', sourceRef: 'verified_fixture' }),
    ledger, rootBudgetId, body, counts: () => ({ networkCalls, failureCalls, saved }) };
}

for (const kind of ['commit', 'transport']) test(`accepted ${kind} keeps its original hold when full failure persistence exceeds its bound`, async () => {
    const subject = await fixture(kind);
    await assert.rejects(subject.run(), error => error instanceof ProviderFault && error.acceptance === 'accepted'
        && error.mayHaveStarted === true && error.retryable === false);
    const { networkCalls, failureCalls, saved } = subject.counts();
    assert.equal(networkCalls, 1);
    assert.equal(failureCalls, 2);
    assert.equal(saved.acceptance, 'accepted');
    assert.equal(saved.rawResponse, undefined);
    assert.equal(saved.partialResponse, undefined);
    assert.deepEqual(saved.error.details.responsePersistence, { code: 'MEDIA_CODEC_LIMIT', completeResponseSaved: false,
        httpStatus: 200, bodyBytes: Buffer.byteLength(subject.body), bodySha256: createHash('sha256').update(subject.body).digest('hex') });
    const finance = await subject.ledger.read(subject.rootBudgetId);
    assert.equal(finance.budget.heldMicros, 100);
    assert.equal(finance.budget.spentCalls, 1);
    assert.equal(finance.charges.length, 0);
});

test('unavailable failure journal retains accepted state without resending or attempting an unbounded fallback', async () => {
    const subject = await fixture('unavailable');
    await assert.rejects(subject.run(), error => error instanceof ProviderFault && error.acceptance === 'accepted'
        && error.mayHaveStarted === true && error.nativeCode === 'STORAGE_DURABILITY_FAILED'
        && typeof error.details.attemptId === 'string' && error.details.actionId === 'journal-state-action');
    assert.equal(subject.counts().networkCalls, 1);
    assert.equal(subject.counts().failureCalls, 1);
    assert.equal((await subject.ledger.read(subject.rootBudgetId)).budget.heldMicros, 100);
});
