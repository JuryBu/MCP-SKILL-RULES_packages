import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { SqliteStore } from '../../../dist/agent-server/storage/sqlite.js';
import { createSqliteProviderPorts } from '../../../dist/agent-server/storage/provider-journal.js';
import { CompatibleChatAdapter, normalizeChatResponse } from '../../../dist/agent-server/providers/compatible-chat.js';
import { freezeRequest, prepareAttempt } from '../../../dist/agent-server/providers/assemble.js';
import { newProfile } from '../../../dist/agent-server/profiles/profile-store.js';

test('raw response remains durable and recoverable after normalized persistence fails and the store reopens', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'sandbox-agent-raw-first-'));
    let store;
    try {
        store = await SqliteStore.open({ dataDir, maxObjectBytes: 8192 });
        const conversationId = randomUUID(), rootBudgetId = randomUUID();
        const now = new Date().toISOString(), deadlineAt = new Date(Date.now() + 60000).toISOString();
        const conversation = { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1,
            value: { conversationId, principalId: 'raw-first-owner', state: 'open', retention: { mode: 'archive', lastRunEnd: null,
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
        await ports.accountingPort.execute({ type: 'create_quota_limit', definition: { quotaLimitId: 'raw-first-limit', currency: 'USD',
            maxCostMicros: 1000, quotaScopeIds: ['raw-first-account'], sourceRef: 'verified_fixture' } });
        await ports.accountingPort.createBudget({ rootBudgetId, mode: 'hard', currency: 'USD', maxCostMicros: 1000,
            maxModelCalls: 1, maxOutputTokens: 32, deadlineAt, sourceRef: 'verified_fixture', quotaLimitId: 'raw-first-limit' });
        const adapter = new CompatibleChatAdapter();
        const profile = { ...newProfile({ profileId: 'raw-first-profile', label: 'raw first fixture', protocol: 'compatible_chat',
            baseUrl: 'http://127.0.0.1:39999/v1', modelId: 'raw-first-model' }), quotaScopeId: 'raw-first-account' };
        const snapshot = freezeRequest({ adapter, profile, modelId: profile.defaultModel, rootBudgetId,
            versions: { conversationId, runId: rootBudgetId, roundId: run.value.activeRoundId, stepId: run.value.activeStepId,
                actionId: randomUUID(), runEpoch: 1, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
                catalogVersion: 'fixture', capabilityVersion: 'fixture', priceVersion: null, toolSchemaHash: 'none',
                skillVersions: {}, attachmentManifestHash: 'none', nativeReplayHash: 'none' },
            view: { protocol: 'compatible_chat', messages: [{ role: 'user', content: 'ordinary raw persistence fixture' }] },
            parameters: { max_tokens: 32 }, deadlineAt });
        const attempt = prepareAttempt(snapshot, rootBudgetId);
        await ports.journal.prepareAttempt(attempt, { amountMicros: 100, currency: 'USD', reliable: true, source: 'fixture', sourceRef: 'verified_fixture' });
        const json = { id: 'raw-first-result', model: profile.defaultModel,
            choices: [{ index: 0, message: { role: 'assistant', content: 'original raw result' }, finish_reason: 'stop' }] };
        const raw = { httpStatus: 200, headers: { 'x-request-id': 'raw-first-request' }, body: JSON.stringify(json), json };
        const response = { ...normalizeChatResponse(attempt.attemptId, raw), blocks: [{ type: 'text', text: 'ordinary output '.repeat(1000) }] };
        await assert.rejects(ports.journal.commitResponse(attempt, response), error => ['MEDIA_CODEC_LIMIT', 'STORAGE_CONTENT_LIMIT'].includes(error.code));
        let saved = await ports.journal.readAttempt(attempt.attemptId);
        assert.equal(saved.state, 'dispatching');
        assert.equal(saved.response, undefined);
        assert.equal(saved.rawResponse, undefined);
        assert.equal(saved.rawResponseArtifact.artifactId, `provider-raw:${attempt.attemptId}`);
        const page = await store.readArtifact({ conversationId, artifactId: saved.rawResponseArtifact.artifactId });
        assert.deepEqual(JSON.parse(Buffer.from(page.dataBase64, 'base64').toString()), raw);
        assert.equal((await ports.accountingPort.read(rootBudgetId)).budget.heldMicros, 100);
        await store.close();
        store = await SqliteStore.open({ dataDir, maxObjectBytes: 8192 });
        ports = createSqliteProviderPorts(store);
        saved = await ports.journal.readAttempt(attempt.attemptId);
        const reopened = await store.readArtifact({ conversationId, artifactId: saved.rawResponseArtifact.artifactId });
        assert.deepEqual(JSON.parse(Buffer.from(reopened.dataBase64, 'base64').toString()), raw);
        assert.equal(saved.response, undefined);
        assert.equal((await ports.accountingPort.read(rootBudgetId)).budget.heldMicros, 100);
    } finally {
        await store?.close();
        assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
        assert.ok(basename(dataDir).startsWith('sandbox-agent-raw-first-'));
        await rm(dataDir, { recursive: true, force: true });
    }
});
