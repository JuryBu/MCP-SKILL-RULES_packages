import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { SqliteStore } from '../../../src/agent-server/storage/sqlite.ts';
import { createSqliteProviderPorts } from '../../../src/agent-server/storage/provider-journal.ts';
import { CompatibleChatAdapter } from '../../../src/agent-server/providers/compatible-chat.ts';
import { freezeRequest, prepareAttempt } from '../../../src/agent-server/providers/assemble.ts';

const deadline = () => new Date(Date.now() + 120_000).toISOString();
const bound = (currency = 'USD') => ({ currency, amountMicros: 100, reliable: true,
    source: 'fixture', sourceRef: 'local-accounting-no-paid-request' });

async function seed(store, profileId, currency = 'USD', bodyBytes = 0) {
    const conversationId = randomUUID();
    const runId = randomUUID();
    const now = new Date().toISOString();
    const rootBudgetId = runId;
    const ports = createSqliteProviderPorts(store);
    await ports.accountingPort.createBudget({ rootBudgetId, mode: 'hard', currency, maxCostMicros: 10_000,
        maxModelCalls: 16, maxOutputTokens: 128, deadlineAt: deadline(), sourceRef: 'local-test-only' });
    const conversation = { key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1,
        value: { conversationId, principalId: 'profile-spend-fixture', state: 'open', retention: { mode: 'archive',
            lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 1 }, createdAt: now, updatedAt: now,
            historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0, runEpoch: 1,
            eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1, activeRunId: runId, options: {} } };
    const run = { key: { conversationId, kind: 'run', id: runId }, revision: 1,
        value: { conversationId, runId, rootRunId: runId, parentRunId: null, kind: 'task', runEpoch: 1,
            state: 'running', phase: 'awaiting_response', effectState: 'none', cleanupState: 'pending',
            activeRoundId: randomUUID(), activeStepId: randomUUID(), pendingInteractionIds: [], budget: { rootBudgetId },
            resultStatus: null, stopReason: null, deadlineAt: deadline(), createdAt: now, updatedAt: now } };
    await store.commitTransition({ expected: [{ key: conversation.key, revision: null }, { key: run.key, revision: null }],
        records: [conversation, run] });
    const modelId = 'profile-local-model';
    const profile = { schemaVersion: 1, profileId, revision: 1, label: 'local-profile', protocol: 'compatible_chat',
        baseUrl: 'https://profile-fixture.invalid/v1', credentialRef: null, credentialGeneration: 0,
        quotaScopeId: 'unverified-provider:compatible_chat', defaultModel: modelId,
        routePolicy: { version: 'fixture', kind: 'direct', allowedModels: [modelId], allowedRoutes: [],
            allowFallbacks: false, evidenceRef: 'fixture' }, parameterDefaults: {}, discovery: { enabled: false, pageSize: 20 },
        remoteRetention: 'disabled', globalModelRulesRef: null, compressionModelRef: null };
    const snapshot = freezeRequest({ adapter: new CompatibleChatAdapter(), profile, modelId,
        versions: { conversationId, runId, roundId: run.value.activeRoundId, stepId: run.value.activeStepId,
            actionId: randomUUID(), runEpoch: 1, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
            catalogVersion: 'fixture', capabilityVersion: 'fixture', priceVersion: null, toolSchemaHash: 'fixture',
            skillVersions: {}, attachmentManifestHash: 'fixture', nativeReplayHash: 'fixture' },
        view: { protocol: 'compatible_chat', messages: [{ role: 'user', content: 'x'.repeat(bodyBytes || 1) }], tools: [] },
        parameters: { max_tokens: 128 }, timeoutMs: 10_000, deadlineAt: deadline() });
    const attempt = prepareAttempt(snapshot, rootBudgetId);
    assert.equal((await ports.journal.prepareAttempt(attempt, bound(currency))).status, 'send');
    return { ports, attempt, rootBudgetId, profile };
}

async function settle(entry, amountMicros, currency = 'USD') {
    await entry.ports.accountingPort.execute({ type: 'settle', attemptId: entry.attempt.attemptId, usageRevision: 1,
        providerExecutionId: `local:${entry.attempt.attemptId}`, complete: amountMicros !== null,
        charges: [{ component: 'model_usage', amountMicros, currency, usage: {}, kind: 'provider_reported' }] });
}

test('same protocol/quota Profiles keep settled, unknown and held separate without changing the ledger; survives reopen', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'profile-spend-exact-'));
    let store = await SqliteStore.open({ dataDir });
    try {
        const first = await seed(store, 'profile-a');
        const second = await seed(store, 'profile-b');
        const unknown = await seed(store, 'profile-a');
        await settle(first, 11);
        await settle(second, 37);
        await unknown.ports.journal.recordFailure(unknown.attempt, { acceptance: 'unknown', error: {
            code: 'E_RESULT_UNKNOWN', message: 'local fixture', retryable: false, mayHaveStarted: true } });
        const before = await Promise.all([first, second, unknown].map(entry => entry.ports.accountingPort.read(entry.rootBudgetId)));
        const report = await store.readProfileSpend('profile-a');
        assert.equal(report.amountMicros, 11);
        assert.equal(report.status, 'partial');
        assert.equal(report.currency, 'USD');
        assert.deepEqual(report.costs, [{ currency: 'USD', amountMicros: 11 }]);
        assert.deepEqual(report.heldCosts, [{ currency: 'USD', amountMicros: 100 }]);
        assert.equal(report.pendingAttempts, 1);
        assert.equal(report.legacyObjectsRead, 0);
        assert.equal(report.unattributedAttempts, 0);
        const other = await store.readProfileSpend('profile-b');
        assert.equal(other.amountMicros, 37);
        assert.equal(other.status, 'known');
        assert.deepEqual(await Promise.all([first, second, unknown].map(entry => entry.ports.accountingPort.read(entry.rootBudgetId))), before);
        await store.close();
        store = await SqliteStore.open({ dataDir });
        const reopened = await store.readProfileSpend('profile-a');
        assert.deepEqual({ ...reopened, observedAt: null }, { ...report, observedAt: null });
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('legacy ownership recovery is read-only and bounded; missing or large ownership stays unresolved', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'profile-spend-legacy-'));
    let store = await SqliteStore.open({ dataDir });
    try {
        const small = await seed(store, 'legacy-a');
        const large = await seed(store, 'legacy-b', 'USD', 96 * 1024);
        const fresh = await seed(store, 'fresh-a', 'USD', 96 * 1024);
        await settle(small, 13);
        await settle(large, 73);
        await settle(fresh, 17);
        assert.equal((await store.readProfileSpend('fresh-a')).legacyObjectsRead, 0);
        await store.close();
        const database = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
        database.prepare('DELETE FROM server_state WHERE kind = ? AND id IN (?,?)')
            .run('providerAttemptProfile', small.attempt.attemptId, large.attempt.attemptId);
        const ledgerBefore = database.prepare('SELECT * FROM charges ORDER BY attempt_id').all();
        database.close();
        store = await SqliteStore.open({ dataDir });
        const knownPart = await store.readProfileSpend('legacy-a');
        assert.equal(knownPart.amountMicros, 13);
        assert.equal(knownPart.status, 'partial');
        assert.equal(knownPart.unattributedAttempts, 1);
        assert.equal(knownPart.legacyObjectsRead, 1);
        assert.ok(knownPart.legacyBytesRead <= 64 * 1024);
        const unknownPart = await store.readProfileSpend('legacy-b', 'USD');
        assert.equal(unknownPart.amountMicros, null);
        assert.equal(unknownPart.status, 'unknown');
        assert.equal(unknownPart.unattributedAttempts, 1);
        const freshPart = await store.readProfileSpend('fresh-a');
        assert.equal(freshPart.amountMicros, 17);
        assert.equal(freshPart.status, 'partial');
        await store.close();
        const verify = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
        assert.deepEqual(verify.prepare('SELECT * FROM charges ORDER BY attempt_id').all(), ledgerBefore);
        assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM server_state WHERE kind = ?').get('providerAttemptProfile').count, 1);
        verify.close();
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('multiple currencies are never added and unknown charges remain explicit', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'profile-spend-currency-'));
    const store = await SqliteStore.open({ dataDir });
    try {
        const usd = await seed(store, 'multi', 'USD');
        const cny = await seed(store, 'multi', 'CNY');
        await settle(usd, 23, 'USD');
        await settle(cny, 41, 'CNY');
        const mixed = await store.readProfileSpend('multi', 'USD');
        assert.equal(mixed.amountMicros, null);
        assert.equal(mixed.status, 'unknown');
        assert.deepEqual(mixed.costs, [{ currency: 'CNY', amountMicros: 41 }, { currency: 'USD', amountMicros: 23 }]);
        const unknown = await seed(store, 'unknown-charge');
        await settle(unknown, null);
        const unresolved = await store.readProfileSpend('unknown-charge');
        assert.equal(unresolved.status, 'unknown');
        assert.equal(unresolved.amountMicros, null);
        assert.equal(unresolved.unknownCharges, 1);
        assert.equal((await unknown.ports.accountingPort.read(unknown.rootBudgetId)).reservations[0].state, 'unsettled');
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('new configured Profile has a known zero before its first request', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'profile-spend-empty-'));
    let store = await SqliteStore.open({ dataDir });
    try {
        const seeded = await seed(store, 'template');
        await settle(seeded, 5);
        const profile = { ...seeded.profile, profileId: 'new-profile', revision: 0, dispatchPolicy: {
            maxCumulativeCost: { currency: 'CNY', amountMicros: 1000 } } };
        await store.executeProfile({ type: 'put', profile, expectedRevision: 0,
            principalId: 'fixture', clientId: 'fixture', clientCommandId: randomUUID() });
        const report = await store.readProfileSpend('new-profile');
        assert.equal(report.amountMicros, 0);
        assert.equal(report.currency, 'CNY');
        assert.equal(report.status, 'known');
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('new temporary finance owns its Profile without storing request bodies and keeps attribution after reopen', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'profile-spend-temporary-'));
    let store = await SqliteStore.open({ dataDir });
    try {
        const ports = createSqliteProviderPorts(store);
        const rootBudgetId = randomUUID();
        await ports.accountingPort.createBudget({ rootBudgetId, mode: 'hard', currency: 'USD', maxCostMicros: 1000,
            maxModelCalls: 16, maxOutputTokens: 128, deadlineAt: deadline(), sourceRef: 'temporary-fixture' });
        const intents = [];
        for (const profileId of ['temporary-a', 'temporary-b']) {
            const ownerInstanceId = randomUUID();
            const conversationId = randomUUID();
            const runId = randomUUID();
            const intent = { ownerInstanceId, conversationId, runId, rootBudgetId, profileId,
                financialIntentId: randomUUID(), dispatchNonce: randomUUID(), attemptId: randomUUID(), actionId: randomUUID(),
                quotaScopeId: 'same-temporary-quota', runEpoch: 1, historyEpoch: 1, fenceRevision: 1 };
            await store.executeTemporaryFee({ type: 'fence', fence: { ownerInstanceId, conversationId, runId,
                runEpoch: 1, historyEpoch: 1, active: true, revision: 1 } });
            const upperBound = { ...bound(), sourceRef: `sha256:${createHash('sha256').update('local-fixture').digest('hex')}` };
            assert.deepEqual(await store.executeTemporaryFee({ type: 'prepare', intent, upperBound }), { status: 'send' });
            intents.push(intent);
        }
        await ports.accountingPort.execute({ type: 'settle', attemptId: intents[0].attemptId, usageRevision: 1,
            providerExecutionId: 'temporary-settled-fixture', complete: true,
            charges: [{ component: 'model_usage', amountMicros: 29, currency: 'USD', usage: {}, kind: 'provider_reported' }] });
        const first = await store.readProfileSpend('temporary-a');
        assert.equal(first.amountMicros, 29);
        assert.equal(first.status, 'known');
        assert.equal(first.legacyObjectsRead, 0);
        const second = await store.readProfileSpend('temporary-b');
        assert.equal(second.amountMicros, null);
        assert.equal(second.status, 'unknown');
        assert.deepEqual(second.heldCosts, [{ currency: 'USD', amountMicros: 100 }]);
        await store.close();
        store = await SqliteStore.open({ dataDir });
        assert.equal((await store.readProfileSpend('temporary-a')).amountMicros, 29);
        assert.deepEqual((await store.readProfileSpend('temporary-b')).heldCosts, second.heldCosts);
        await store.close();
        const verify = new DatabaseSync(join(dataDir, 'catalog.sqlite'));
        assert.equal(verify.prepare('SELECT COUNT(*) AS count FROM objects').get().count, 0);
        verify.close();
    } finally { await store.close(); await rm(dataDir, { recursive: true, force: true }); }
});
