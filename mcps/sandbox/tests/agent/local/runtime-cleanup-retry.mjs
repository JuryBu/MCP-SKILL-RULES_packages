import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';

const client = { principalId: 'own-cleanup-retry', clientId: 'own-cleanup-client' };
async function request(runtime, method, params) {
    const result = await runtime.dispatch(method, params, client);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result.data;
}

for (const terminal of [{ result: 'failed', state: 'failed' }, { result: 'succeeded', state: 'succeeded' }]) {
test(`normal close retries ${terminal.state} cold cleanup only after trusted confirmation and preserves original effects`, { timeout: 45_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sandbox-agent-cleanup-retry-'));
    const dataDir = join(directory, 'state');
    let runtime;
    let executions = 0;
    let confirmed = false;
    const observations = [];
    try {
        runtime = createAgentRuntime({ store: await openAgentStore({ dataDir }), executor: { async execute() {
            executions++;
            return { status: terminal.result, cleanupState: 'unconfirmed', effectState: 'confirmed', stopReason: 'OWN_CLEANUP_PENDING' };
        } } });
        const conversation = await request(runtime, 'conversations.create', { clientCommandId: randomUUID(), retention: { mode: 'archive' } });
        const started = await request(runtime, 'runs.start', { conversationId: conversation.conversationId,
            controlLeaseId: conversation.controlLeaseId, controlEpoch: conversation.controlEpoch, clientCommandId: randomUUID(),
            input: { text: 'own runtime lifecycle test; no external model request' },
            budget: { wallMs: 60_000, maxModelCalls: 1, maxOutputTokens: 16, costMode: 'estimated' } });
        const query = { conversationId: conversation.conversationId, runId: started.runId };
        let original;
        for (let index = 0; index < 300; index++) {
            original = await request(runtime, 'runs.get', query);
            if (original.state === terminal.state) break;
            await delay(5);
        }
        assert.equal(original.state, terminal.state);
        assert.equal(original.cleanupState, 'unconfirmed');
        assert.equal(original.internalOwnCleanupState, 'unconfirmed');
        await runtime.close();
        runtime = createAgentRuntime({ store: await openAgentStore({ dataDir }), reconcileRunCleanup: async input => {
            observations.push(input);
            return confirmed ? 'resources_released' : 'unconfirmed';
        } });
        const lease = await request(runtime, 'server.claimControl', { scope: 'conversation', conversationId: query.conversationId,
            clientCommandId: randomUUID(), takeover: true });
        const close = () => request(runtime, 'conversations.close', { conversationId: query.conversationId,
            controlLeaseId: lease.controlLeaseId, controlEpoch: lease.controlEpoch, clientCommandId: randomUUID() });
        await close();
        const retained = await request(runtime, 'runs.get', query);
        assert.equal(retained.cleanupState, 'unconfirmed');
        assert.equal(retained.internalOwnCleanupState, 'unconfirmed');
        assert.equal((await request(runtime, 'conversations.get', { conversationId: query.conversationId })).state, 'closing');
        confirmed = true;
        await close();
        const released = await request(runtime, 'runs.get', query);
        assert.equal(released.cleanupState, 'released');
        assert.equal(released.internalOwnCleanupState, 'released');
        assert.equal(released.state, original.state);
        assert.equal(released.effectState, original.effectState);
        assert.equal(released.resultStatus, original.resultStatus);
        assert.equal(released.runEpoch, original.runEpoch);
        const closed = await request(runtime, 'conversations.get', { conversationId: query.conversationId });
        assert.equal(closed.state, 'closed');
        assert.equal(closed.activeRunId, null);
        assert.equal(executions, 1);
        assert.equal(observations.length, 2);
    } finally {
        await runtime?.close();
        assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
        assert.ok(basename(directory).startsWith('sandbox-agent-cleanup-retry-'));
        await rm(directory, { recursive: true, force: true });
    }
});
}
