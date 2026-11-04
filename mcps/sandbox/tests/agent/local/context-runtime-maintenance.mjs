import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { BudgetLedger, MemoryAccountingPort } from '../../../src/agent-server/accounting/budget-ledger.ts';
import { createContextMaintenanceCallbacks } from '../../../src/agent-server/context/maintenance-budget.ts';
import { fixtureConfig } from './context-fixtures.mjs';

const client = { principalId: 'own-runtime-maintenance', clientId: 'own-runtime-cli', callerHost: 'standalone-cli' };
const budget = { costMode: 'hard', currency: 'USD', quotaLimitId: 'own-maintenance-total', maxCostMicros: 1000,
    maxModelCalls: 4, maxOutputTokens: 512, wallMs: 60000 };
async function until(operation, predicate) {
    for (let ordinal = 0; ordinal < 300; ordinal++) { const value = await operation(); if (predicate(value)) return value; await delay(5); }
    assert.fail('own normal Runtime operation did not settle');
}
async function fixture(executor) {
    const store = new MemoryStore();
    const runtime = createAgentRuntime({ store, executor, cleanupGraceMs: 1000 });
    const prepared = await runtime.dispatch('conversations.prepareTemporaryCreate', {}, client);
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    const created = await runtime.dispatch('conversations.create', { clientCommandId: prepared.data.clientCommandId, retention: { mode: 'temporary' },
        options: { writeRoots: ['C:/own-runtime-fixture'] } }, client);
    assert.equal(created.ok, true, JSON.stringify(created));
    const control = { conversationId: created.data.conversationId, controlLeaseId: created.data.controlLeaseId, controlEpoch: created.data.controlEpoch };
    const ledger = new BudgetLedger(new MemoryAccountingPort());
    await ledger.createQuotaLimit({ quotaLimitId: budget.quotaLimitId, currency: 'USD', maxCostMicros: 10000,
        quotaScopeIds: ['own-account'], sourceRef: 'verified_fixture' });
    const callbacks = createContextMaintenanceCallbacks({ ledger, lifecycle: {
        createRun: input => runtime.createMaintenanceRun(input, { client, params: control }, async () => 'resources_released'),
        finishRun: input => runtime.finishMaintenanceRun(input),
    } });
    return { store, runtime, control, ledger, callbacks };
}

test('normal Runtime maintenance has an idempotent UUID root and CAS events, with no human input or history consumption', async () => {
    const own = await fixture();
    try {
        const config = fixtureConfig();
        const input = { conversationId: own.control.conversationId, operationId: randomUUID(), config, budget };
        const execution = await own.callbacks.createRun(input);
        assert.equal(execution.kind, 'maintenance');
        assert.equal(execution.runId, execution.rootBudgetId);
        assert.match(execution.runId, /^[0-9a-f-]{36}$/);
        assert.equal(execution.roundId, null);
        assert.deepEqual(await own.callbacks.createRun(input), execution);
        assert.equal((await own.store.listRecords({ kind: 'run', conversationId: input.conversationId, limit: 50 })).items.length, 1);
        assert.equal((await own.store.listRecords({ kind: 'input', conversationId: input.conversationId, limit: 50 })).items.length, 0);
        assert.equal((await own.store.readHistory({ conversationId: input.conversationId })).items.length, 0);
        await own.callbacks.finishRun({ execution, result: 'published' });
        const run = await own.runtime.dispatch('runs.get', { conversationId: input.conversationId, runId: execution.runId }, client);
        assert.equal(run.data.state, 'succeeded');
        assert.equal(run.data.activeRoundId, null);
        const events = await own.runtime.dispatch('events.read', { conversationId: input.conversationId }, client);
        assert.ok(events.data.events.some(event => event.type === 'run.maintenanceStarted'));
        assert.ok(events.data.events.some(event => event.type === 'run.maintenanceFinished'));
        assert.equal((await own.ledger.read(execution.rootBudgetId)).budget.spentCalls, 0);
    } finally { await own.runtime.close(); }
});

test('normal Runtime metered maintenance keeps its supplied budget without requiring a quota', async () => {
    const own = await fixture();
    try {
        const execution = await own.callbacks.createRun({ conversationId: own.control.conversationId,
            operationId: randomUUID(), config: fixtureConfig(),
            budget: { costMode: 'metered', currency: 'USD', maxCostMicros: null,
                maxModelCalls: 48, maxOutputTokens: 2048, wallMs: 60000 } });
        const root = await own.ledger.read(execution.rootBudgetId);
        assert.equal(root.budget.mode, 'metered');
        assert.equal(root.budget.quotaLimitId, undefined);
        assert.equal(root.budget.maxCostMicros, null);
        const run = await own.runtime.dispatch('runs.get', { conversationId: own.control.conversationId,
            runId: execution.runId }, client);
        assert.equal(run.data.budget.costMode, 'metered');
        await own.callbacks.finishRun({ execution, result: 'published' });
        const finished = await own.runtime.dispatch('runs.get', { conversationId: own.control.conversationId,
            runId: execution.runId }, client);
        assert.equal(finished.data.state, 'succeeded');
    } finally { await own.runtime.close(); }
});

test('trusted conversation write authorization requires the current controller, and normal maintenance cancellation settles its original run', async () => {
    const own = await fixture();
    try {
        await assert.rejects(own.runtime.authorizeConversationWrite(client, { conversationId: own.control.conversationId }), { code: 'CONTROL_REQUIRED' });
        await own.runtime.authorizeConversationWrite(client, own.control);
        const execution = await own.callbacks.createRun({ conversationId: own.control.conversationId, operationId: randomUUID(), config: fixtureConfig(), budget });
        const cancelled = await own.runtime.dispatch('runs.cancel', { ...own.control, runId: execution.runId,
            expectedRunEpoch: execution.runEpoch, clientCommandId: randomUUID() }, client);
        assert.equal(cancelled.ok, true, JSON.stringify(cancelled));
        const run = await until(() => own.runtime.dispatch('runs.get', { conversationId: own.control.conversationId, runId: execution.runId }, client), result => result.data?.state === 'cancelled');
        assert.equal(run.data.runEpoch, execution.runEpoch + 1);
        assert.equal(run.data.cleanupState, 'released');
        assert.equal((await own.ledger.read(execution.rootBudgetId)).budget.spentCalls, 0);
    } finally { await own.runtime.close(); }
});

test('normal workspace quiesce stops an actual running task, rebases the restore epoch, and never consumes queued input on release', async () => {
    let executing;
    const own = await fixture({ capabilities: { hardBudget: true }, async execute(context) {
        executing = context;
        await new Promise(resolveStopped => context.signal.addEventListener('abort', resolveStopped, { once: true }));
        return { status: 'paused', effectState: 'confirmed', cleanupState: 'released' };
    } });
    try {
        const started = await own.runtime.dispatch('runs.start', { ...own.control, clientCommandId: randomUUID(), input: { text: 'ordinary owned work' }, budget }, client);
        assert.equal(started.ok, true, JSON.stringify(started));
        await until(async () => executing, value => Boolean(value));
        const queued = await own.runtime.dispatch('inputs.submit', { ...own.control, clientCommandId: randomUUID(), runId: started.data.runId,
            expectedRunEpoch: executing.snapshot.runEpoch, expectedHistoryEpoch: 1, mode: 'queue', content: { text: 'keep this queued until explicit resume' } }, client);
        assert.equal(queued.ok, true, JSON.stringify(queued));
        const context = { conversationId: own.control.conversationId, runId: started.data.runId, rootRunId: started.data.runId,
            runEpoch: executing.snapshot.runEpoch, principalId: client.principalId, policyRevision: 1, retention: { mode: 'temporary' },
            roundId: executing.snapshot.activeRoundId, actionId: randomUUID(), attemptId: randomUUID(), roots: [], signal: new AbortController().signal };
        const guard = await own.runtime.quiesceWorkspace({ restorePlanId: randomUUID(), mode: 'files_only', expectedHistoryEpoch: 1,
            expectedWorkspaceRevision: 0 }, context, { client, params: own.control }, async () => true);
        assert.equal(context.runEpoch, executing.snapshot.runEpoch + 1);
        const paused = await own.runtime.dispatch('runs.get', { conversationId: own.control.conversationId, runId: started.data.runId }, client);
        assert.equal(paused.data.state, 'paused');
        await guard.release();
        const inputs = await own.runtime.dispatch('inputs.list', { conversationId: own.control.conversationId, runId: started.data.runId }, client);
        assert.equal(inputs.data.items.filter(item => item.state === 'queued').length, 1);
        assert.equal((await own.runtime.dispatch('runs.get', { conversationId: own.control.conversationId, runId: started.data.runId }, client)).data.state, 'paused');
    } finally { await own.runtime.close(); }
});
