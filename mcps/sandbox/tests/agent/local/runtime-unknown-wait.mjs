import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { reconcileRunCleanup } from '../../../src/agent-server/cleanup-reconciliation.ts';
import { parseArguments } from '../../../src/agent-cli/arguments.ts';
import { COMMAND_SPECS } from '../../../src/agent-cli/commands.ts';
import { openAgentStore } from '../../../dist/agent-server/storage/index.js';

async function fixture(options = {}) {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-agent-unknown-wait-'));
    const client = { principalId: randomUUID(), clientId: randomUUID() };
    const actionId = randomUUID();
    const attemptId = randomUUID();
    let releaseFirst;
    const gate = new Promise(resolve => { releaseFirst = resolve; });
    if (!options.gated) releaseFirst();
    let executions = 0;
    const cleanupInputs = [];
    const runtime = createAgentRuntime({
        store: await openAgentStore({ dataDir: join(root, 'data') }),
        cleanupGraceMs: 50,
        reconcileRunCleanup: async input => { cleanupInputs.push(structuredClone(input)); return options.cleanup ?? 'resources_released'; },
        executor: { async execute(context) {
            executions++;
            if (executions > 1) return { status: 'succeeded', result: { ordinaryNextTask: true }, cleanupState: 'not_needed' };
            await context.checkpoint('awaiting_response', { actionId, attemptId });
            await gate;
            return { status: 'outcome_unknown', stopReason: 'E_RESULT_UNKNOWN', effectState: 'unknown', cleanupState: 'not_needed',
                failure: { error: { code: 'E_RESULT_UNKNOWN', message: 'owned transport-state fixture', retryable: false, mayHaveStarted: true },
                    acceptance: 'accepted', cleanupEvidence: 'no_resources_created', actionId, attemptId } };
        } },
    });
    const send = (method, params) => runtime.dispatch(method, params, client);
    const request = async (method, params) => {
        const result = await send(method, params);
        assert.equal(result.ok, true, JSON.stringify(result.error));
        return result.data;
    };
    const conversation = await request('conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' } });
    const control = { conversationId: conversation.conversationId, controlLeaseId: conversation.controlLeaseId, controlEpoch: conversation.controlEpoch };
    const start = () => request('runs.start', { ...control, clientCommandId: randomUUID(), input: { text: 'ordinary isolated state task' },
        budget: { wallMs: 60_000, maxModelCalls: 8, maxOutputTokens: 64, costMode: 'estimated' } });
    const first = await start();
    const query = { conversationId: conversation.conversationId, runId: first.runId };
    const wait = async state => {
        for (let index = 0; index < 400; index++) {
            const run = await request('runs.get', query);
            if (run.state === state) { await delay(2); return run; }
            await delay(2);
        }
        throw new Error('owned runtime state did not settle');
    };
    await wait(options.gated ? 'running' : 'outcome_unknown');
    const cancelParams = run => ({ ...control, runId: first.runId, expectedRunEpoch: run.runEpoch,
        clientCommandId: randomUUID(), acknowledgeUnknown: true });
    return { runtime, send, request, conversation, control, query, start, wait, cancelParams, cleanupInputs, releaseFirst,
        executions: () => executions, async close() {
            releaseFirst();
            await runtime.close();
            if (!resolve(root).startsWith(resolve(tmpdir()) + sep) || !root.includes('sandbox-agent-unknown-wait-')) throw new Error('fixture cleanup path changed');
            await rm(root, { recursive: true, force: true });
        } };
}

test('explicit unknown-wait end keeps the original outcome and continues the same conversation', async () => {
    const owned = await fixture();
    try {
        const before = await owned.request('runs.get', owned.query);
        const ended = await owned.request('runs.cancel', owned.cancelParams(before));
        assert.equal(ended.state, 'cancelled');
        assert.equal(ended.waitEnded, true);
        assert.equal(ended.resultStatus, 'unknown');
        assert.equal(ended.effectState, 'unknown');
        assert.equal(ended.accountingUnchanged, true);
        assert.deepEqual(ended.failure, before.failure);
        assert.deepEqual(ended.budget, before.budget);
        assert.equal(ended.runEpoch, before.runEpoch + 1);
        assert.equal(owned.cleanupInputs.at(-1).preserveUnknownOutcome, true);
        const conversation = await owned.request('conversations.get', { conversationId: owned.conversation.conversationId });
        assert.equal(conversation.activeRunId, null);
        assert.equal(conversation.retention.activeRuns, 0);
        const next = await owned.start();
        assert.notEqual(next.runId, before.runId);
        assert.deepEqual((await owned.request('runs.get', owned.query)).failure, before.failure);
    } finally { await owned.close(); }
});

for (const variant of [
    { name: 'ordinary cancel', code: 'OUTCOME_UNKNOWN', mutate: params => { delete params.acknowledgeUnknown; } },
    { name: 'stale version', code: 'STALE_RUN_EPOCH', mutate: params => { params.expectedRunEpoch++; } },
    { name: 'unconfirmed local resources', code: 'CLEANUP_UNCONFIRMED', cleanup: 'unconfirmed', mutate() {} },
]) test(`${variant.name} retains the original unknown wait`, async () => {
    const owned = await fixture({ cleanup: variant.cleanup });
    try {
        const before = await owned.request('runs.get', owned.query);
        const params = owned.cancelParams(before);
        variant.mutate(params);
        assert.equal((await owned.send('runs.cancel', params)).error.code, variant.code);
        assert.equal((await owned.request('runs.get', owned.query)).state, 'outcome_unknown');
        assert.equal((await owned.request('conversations.get', { conversationId: owned.conversation.conversationId })).activeRunId, before.runId);
    } finally { await owned.close(); }
});

test('the explicit unknown-wait flag leaves a healthy active task running', async () => {
    const owned = await fixture({ gated: true });
    try {
        const running = await owned.request('runs.get', owned.query);
        assert.equal((await owned.send('runs.cancel', owned.cancelParams(running))).error.code, 'INVALID_STATE');
        assert.equal((await owned.request('runs.get', owned.query)).state, 'running');
        assert.equal(owned.cleanupInputs.length, 0);
    } finally { await owned.close(); }
});

test('replay returns the original end-wait receipt without affecting the next root', async () => {
    const owned = await fixture();
    try {
        const before = await owned.request('runs.get', owned.query);
        const params = owned.cancelParams(before);
        const first = await owned.send('runs.cancel', params);
        assert.equal(first.ok, true);
        const next = await owned.start();
        assert.deepEqual(await owned.send('runs.cancel', params), first);
        const conversation = await owned.request('conversations.get', { conversationId: owned.conversation.conversationId });
        assert.ok(conversation.activeRunId === next.runId || conversation.activeRunId === null);
        assert.equal(owned.executions(), 2);
    } finally { await owned.close(); }
});

test('unconsumed queued input keeps its draft identity after ending the unknown wait', async () => {
    const owned = await fixture({ gated: true });
    try {
        const running = await owned.request('runs.get', owned.query);
        const draftId = randomUUID();
        const queued = await owned.request('inputs.submit', { ...owned.control, runId: running.runId, expectedRunEpoch: running.runEpoch,
            expectedHistoryEpoch: 1, clientCommandId: randomUUID(), mode: 'queue', draftId, draftRevision: 3, content: { text: 'unconsumed queued draft' } });
        owned.releaseFirst();
        const unknown = await owned.wait('outcome_unknown');
        await owned.request('runs.cancel', owned.cancelParams(unknown));
        const inputs = await owned.request('inputs.list', { conversationId: owned.conversation.conversationId, runId: running.runId });
        const saved = inputs.items.find(item => item.inputId === queued.inputId);
        assert.equal(saved.state, 'withdrawn');
        assert.equal(saved.draftId, draftId);
        assert.equal(saved.draftRevision, 3);
        assert.equal(saved.preview.text, 'unconsumed queued draft');
    } finally { await owned.close(); }
});

test('local-only confirmation leaves a nonzero unknown monetary hold untouched', async () => {
    const reservation = { state: 'unknown', heldMicros: 123456, callHeld: true, attemptId: randomUUID() };
    const before = structuredClone(reservation);
    const calls = [];
    const result = await reconcileRunCleanup({ snapshot: { conversationId: randomUUID(), runId: randomUUID(), state: 'outcome_unknown' },
        conversationOptions: {}, preserveUnknownOutcome: true }, {
        readBudget: async () => { calls.push('budget'); return { reservations: [reservation] }; },
        readAttempt: async () => { calls.push('attempt'); return undefined; },
        releaseTools: async () => { calls.push('local-tools'); return 'released'; },
        releaseContext: async () => { calls.push('local-context'); return true; },
    });
    assert.equal(result, 'resources_released');
    assert.deepEqual(calls, ['local-tools', 'local-context']);
    assert.deepEqual(reservation, before);
});

test('the CLI exposes acknowledgement as an explicit boolean cancel option', () => {
    assert.equal(parseArguments(['cancel', 'owned-run', '--acknowledge-unknown']).options['acknowledge-unknown'], true);
    assert.equal(COMMAND_SPECS.find(spec => spec.name === 'cancel').argsSchema.options['acknowledge-unknown'], 'boolean');
});
