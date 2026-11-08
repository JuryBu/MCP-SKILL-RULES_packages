import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SqliteStore } from '../../../dist/agent-server/storage/sqlite.js';
import { createSqliteProviderPorts } from '../../../dist/agent-server/storage/provider-journal.js';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../dist/agent-server/providers/compatible-chat.js';
import { freezeRequest, prepareAttempt } from '../../../dist/agent-server/providers/assemble.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';

test('accepted large failure remains readable after cold open and later response commit without another dispatch', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sandbox-agent-large-failure-'));
    let store;
    try {
        store = await SqliteStore.open({ dataDir });
        const conversationId = randomUUID(), rootBudgetId = randomUUID();
        const now = new Date().toISOString(), deadlineAt = new Date(Date.now() + 60000).toISOString();
        const conversation = { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1,
            value: { conversationId, principalId: 'large-failure-owner', state: 'open', retention: { mode: 'archive', lastRunEnd: null,
                lastClose: null, expiresAt: null, activeRuns: 1 }, createdAt: now, updatedAt: now, historyEpoch: 1,
                appendSeq: 0, viewRevision: 0, workspaceRevision: 0, runEpoch: 1, eventGeneration: randomUUID(), eventSeq: '0',
                policyRevision: 1, activeRunId: rootBudgetId, options: {} } };
        const run = { key: { conversationId, kind: 'run', id: rootBudgetId }, revision: 1,
            value: { conversationId, runId: rootBudgetId, rootRunId: rootBudgetId, parentRunId: null, kind: 'task', runEpoch: 1,
                state: 'running', phase: 'awaiting_response', effectState: 'none', cleanupState: 'pending', activeRoundId: randomUUID(),
                activeStepId: randomUUID(), pendingInteractionIds: [], budget: { rootBudgetId }, resultStatus: null, stopReason: null,
                deadlineAt, createdAt: now, updatedAt: now } };
        await store.commitTransition({ expected: [{ key: conversation.key, revision: null }, { key: run.key, revision: null }], records: [conversation, run] });
        let ports = createSqliteProviderPorts(store);
        await ports.accountingPort.execute({ type: 'create_quota_limit', definition: { quotaLimitId: 'large-failure-limit', currency: 'USD',
            maxCostMicros: 1000, quotaScopeIds: ['large-failure-account'], sourceRef: 'verified_fixture' } });
        await ports.accountingPort.createBudget({ rootBudgetId, mode: 'hard', currency: 'USD', maxCostMicros: 1000,
            maxModelCalls: 1, maxOutputTokens: 32, deadlineAt, sourceRef: 'verified_fixture', quotaLimitId: 'large-failure-limit' });
        const profile = { ...newProfile({ profileId: 'large-failure-profile', label: 'large failure fixture', protocol: 'compatible_chat',
            baseUrl: 'http://127.0.0.1:39999/v1', modelId: 'large-failure-model' }), quotaScopeId: 'large-failure-account' };
        const snapshot = freezeRequest({ adapter: new CompatibleChatAdapter(), profile, modelId: profile.defaultModel, rootBudgetId,
            versions: { conversationId, runId: rootBudgetId, roundId: run.value.activeRoundId, stepId: run.value.activeStepId,
                actionId: randomUUID(), runEpoch: 1, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
                catalogVersion: 'fixture', capabilityVersion: 'fixture', priceVersion: null, toolSchemaHash: 'none',
                skillVersions: {}, attachmentManifestHash: 'none', nativeReplayHash: 'none' },
            view: { protocol: 'compatible_chat', messages: [{ role: 'user', content: 'bounded failure recovery fixture' }] },
            parameters: { max_tokens: 32 }, deadlineAt });
        const attempt = prepareAttempt(snapshot, rootBudgetId);
        await ports.journal.prepareAttempt(attempt, { amountMicros: 100, currency: 'USD', reliable: true, source: 'fixture', sourceRef: 'verified_fixture' });
        const dataBase64 = Buffer.alloc(13 * 1024 * 1024, 91).toString('base64');
        const json = { inlineData: { mimeType: 'image/png', data: dataBase64 } };
        const rawResponse = { httpStatus: 200, headers: { 'x-request-id': 'owned-large-failure' }, body: JSON.stringify(json), json };
        const failure = { acceptance: 'accepted', error: { code: 'E_PROVIDER', message: 'owned incomplete response', retryable: false,
            mayHaveStarted: true }, rawResponse };
        assert.ok(Buffer.byteLength(JSON.stringify(failure)) > 32 * 1024 * 1024);
        await ports.journal.recordFailure(attempt, failure);
        await store.close();
        store = await SqliteStore.open({ dataDir });
        ports = createSqliteProviderPorts(store);
        let saved = await ports.journal.readAttempt(attempt.attemptId);
        assert.equal(saved.state, 'unknown');
        assert.equal(saved.failure.acceptance, 'accepted');
        assert.deepEqual(saved.failure.error, failure.error);
        assert.equal(createHash('sha256').update(saved.failure.rawResponse.body).digest('hex'),
            createHash('sha256').update(rawResponse.body).digest('hex'));
        assert.equal(saved.failure.rawResponse.json.inlineData.data, dataBase64);
        const held = await ports.accountingPort.read(rootBudgetId);
        assert.equal(held.budget.heldMicros, 100);
        assert.equal(held.budget.spentCalls, 1);
        assert.equal(held.charges.length, 0);
        const completed = { id: 'owned-large-failure-result', model: profile.defaultModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'recovered original response' }, finish_reason: 'stop' }] };
        const response = normalizeChatResponse(attempt.attemptId, { httpStatus: 200, headers: {}, body: JSON.stringify(completed), json: completed });
        await ports.journal.commitResponse(attempt, response);
        await store.close();
        store = await SqliteStore.open({ dataDir });
        ports = createSqliteProviderPorts(store);
        saved = await ports.journal.readAttempt(attempt.attemptId);
        assert.equal(saved.state, 'committed');
        assert.equal(saved.failure.acceptance, 'accepted');
        assert.equal(saved.response.blocks[0].text, 'recovered original response');
        assert.equal((await ports.accountingPort.read(rootBudgetId)).budget.spentCalls, 1);
        assert.equal((await ports.journal.prepareAttempt(attempt, { amountMicros: 100, currency: 'USD', reliable: true,
            source: 'fixture', sourceRef: 'verified_fixture' })).status, 'committed');
    } finally {
        await store?.close();
        assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
        assert.ok(basename(dataDir).startsWith('sandbox-agent-large-failure-'));
        await rm(dataDir, { recursive: true, force: true });
    }
});
