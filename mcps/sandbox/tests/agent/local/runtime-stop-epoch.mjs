import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { createAgentRuntime } from '../../../src/agent-server/runtime.ts';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { AgentFault } from '../../../src/agent-server/protocol.ts';

const client = { principalId: 'owned-stop-epoch', clientId: 'owned-stop-epoch-client' };
const budget = { wallMs: 60000, maxModelCalls: 2, costMode: 'estimated', maxOutputTokens: 64 };
const proof = data => ({ conversationId: data.conversationId, controlLeaseId: data.controlLeaseId, controlEpoch: data.controlEpoch });
function deferred() {
    let resolve;
    const promise = new Promise(complete => { resolve = complete; });
    return { promise, resolve };
}
async function request(runtime, method, params) {
    const result = await runtime.dispatch(method, params, client);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    return result;
}

test('an interrupted storage reply cannot let the first interrupt completion release a resumed and interrupted epoch', async () => {
    const store = new MemoryStore();
    const commit = store.commitTransition.bind(store);
    const completion = deferred();
    let context;
    let runtime;
    let conversation;
    let started;
    let interleaving;
    let interruptedReply = false;
    let delayedRetry = false;
    let executions = 0;
    const lifecycle = [];
    const originalSetTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (operation, milliseconds, ...arguments_) => {
        if (interruptedReply && !delayedRetry && milliseconds === 1) {
            delayedRetry = true;
            return originalSetTimeout(operation, 150, ...arguments_);
        }
        return originalSetTimeout(operation, milliseconds, ...arguments_);
    };
    store.commitTransition = async transition => {
        const result = await commit(transition);
        lifecycle.push({ events: transition.events?.map(event => event.type), run: transition.records?.filter(record => record.key.kind === 'run')
            .map(record => ({ epoch: record.value.runEpoch, state: record.value.state, cleanup: record.value.cleanupState })) });
        if (!interruptedReply && transition.events?.some(event => event.type === 'run.paused'
            && event.payload.cleanupState === 'released')) {
            interruptedReply = true;
            interleaving = (async () => {
                const resumed = await request(runtime, 'runs.resume', { ...proof(conversation), clientCommandId: randomUUID(),
                    runId: started.runId, expectedRunEpoch: started.runEpoch + 1, expectedHistoryEpoch: conversation.historyEpoch });
                const stopped = await request(runtime, 'runs.interrupt', { ...proof(conversation), clientCommandId: randomUUID(),
                    runId: started.runId, expectedRunEpoch: resumed.data.runEpoch });
                return stopped.data;
            })();
            void interleaving.catch(() => {});
            await delay(2);
            throw new AgentFault('REVISION_CONFLICT', 'Owned storage completion reply was interrupted',
                { expectedRevision: 0, currentRevision: 1 });
        }
        return result;
    };
    runtime = createAgentRuntime({ store, cleanupGraceMs: 2000, executor: { async execute(input) {
        executions++;
        context = input;
        return completion.promise;
    } } });
    try {
        const prepared = (await request(runtime, 'conversations.prepareTemporaryCreate', {})).data;
        conversation = (await request(runtime, 'conversations.create', { clientCommandId: prepared.clientCommandId,
            retention: { mode: 'temporary' } })).data;
        conversation.historyEpoch = (await request(runtime, 'conversations.get', { conversationId: conversation.conversationId })).data.historyEpoch;
        started = (await request(runtime, 'runs.start', { ...proof(conversation), clientCommandId: randomUUID(),
            input: { text: 'Ordinary interrupt, resume and interrupt sequence' }, budget })).data;
        for (let attempt = 0; !context && attempt < 200; attempt++) await delay(5);
        assert.ok(context);
        await request(runtime, 'runs.interrupt', { ...proof(conversation), clientCommandId: randomUUID(),
            runId: started.runId, expectedRunEpoch: started.runEpoch });
        completion.resolve({ status: 'paused', cleanupState: 'released' });
        for (let attempt = 0; !interleaving && attempt < 200; attempt++) await delay(5);
        assert.ok(interleaving);
        const secondStop = await interleaving;
        await delay(200);
        const current = (await request(runtime, 'runs.get', { conversationId: conversation.conversationId, runId: started.runId })).data;
        console.log(JSON.stringify({ scope: 'owned-normal-interrupt-resume-stop', delayedRetry, executions, lifecycle,
            final: { epoch: current.runEpoch, state: current.state, cleanup: current.cleanupState } }));
        assert.equal(current.runEpoch, secondStop.runEpoch);
        assert.equal(current.runEpoch, started.runEpoch + 3);
        assert.equal(current.state, 'paused');
        assert.equal(current.cleanupState, 'unconfirmed');
        assert.equal(executions, 1);
        assert.equal(delayedRetry, true);
    } finally {
        globalThis.setTimeout = originalSetTimeout;
        completion.resolve({ status: 'paused', cleanupState: 'released' });
        await runtime.close();
    }
});
