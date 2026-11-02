import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { ResourceRegistry } from '../../../src/agent-server/resources/registry.ts';
import { AgentPendingToolStore } from '../../../src/agent-server/storage/temporary-pending.ts';
import { openAgentStore } from '../../../dist/agent-server/storage/index.js';

function fixture(options = {}) {
    const runId = randomUUID();
    const context = { principalId: randomUUID(), conversationId: randomUUID(), runId, rootRunId: runId,
        roundId: randomUUID(), actionId: randomUUID(), attemptId: randomUUID(), runEpoch: 1, policyRevision: 1,
        retention: options.retention ?? { mode: 'archive' }, roots: [], signal: AbortSignal.abort('read-only cleanup confirmation') };
    const resources = new ResourceRegistry();
    const calls = [];
    for (const method of ['closeRun', 'close', 'status', 'renew']) resources[method] = async () => {
        calls.push(method);
        throw new Error('read-only confirmation must not invoke a resource operation');
    };
    const shared = { releaseLocalRun() { calls.push('local-cache'); }, releaseLoadedTools() { calls.push('schema-cache'); },
        async releaseResourceLeases() { calls.push('remote-lease'); throw new Error('remote lease operation was not requested'); } };
    const router = new ToolRouter({ resources, shared, pendingTools: options.pendingTools });
    const record = released => ({ resourceId: randomUUID(), issuerId: resources.issuerId, principalId: context.principalId,
        conversationId: context.conversationId, runId, rootRunId: runId, runEpoch: 1, actionId: context.actionId,
        requestId: randomUUID(), argsHash: 'owned-arguments', adapterId: 'owned.normal-fixture', kind: 'owned-state-fixture',
        leaseUntil: new Date(Date.now() + 60_000).toISOString(), state: released ? 'released' : 'unresolved',
        cleanupState: released ? 'released' : 'unconfirmed', retention: context.retention,
        receipt: { started: true, terminalConfirmed: released, released, evidence: { originalRequestPreserved: true } } });
    return { context, resources, router, calls, record };
}

test('a run with no owned resources releases only local caches without invoking adapters', async () => {
    const owned = fixture();
    assert.equal(await owned.router.confirmReleased(owned.context), 'not_needed');
    assert.deepEqual(owned.calls, ['local-cache', 'schema-cache']);
});

test('an unresolved original resource stays unchanged without cancellation or remote status calls', async () => {
    const owned = fixture();
    const original = owned.record(false);
    await owned.resources.store.allocate(original);
    assert.equal(await owned.router.confirmReleased(owned.context), 'unconfirmed');
    assert.deepEqual(await owned.resources.store.get(original.resourceId), original);
    assert.deepEqual(owned.calls, []);
});

test('released original resources are confirmed from their original receipt alone', async () => {
    const owned = fixture();
    const original = owned.record(true);
    await owned.resources.store.allocate(original);
    assert.equal(await owned.router.confirmReleased(owned.context), 'released');
    assert.deepEqual(await owned.resources.store.get(original.resourceId), original);
    assert.deepEqual(owned.calls, ['local-cache', 'schema-cache']);
});

test('an unfinished original pending tool prevents local waiting from being cleared', async () => {
    const owned = fixture();
    owned.router.pendingTools.list = async () => ({ items: [{ state: 'outcome_unknown' }], nextCursor: null });
    assert.equal(await owned.router.confirmReleased(owned.context), 'unconfirmed');
    assert.deepEqual(owned.calls, []);
});

for (const withPending of [false, true]) test(`temporary control pagination reaches the last page before confirming: pending=${withPending}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sandbox-agent-pending-confirmation-'));
    const store = await openAgentStore({ dataDir: join(directory, 'data') });
    try {
        const pendingTools = new AgentPendingToolStore(store);
        const owned = fixture({ retention: { mode: 'temporary' }, pendingTools });
        const conversationKey = { conversationId: owned.context.conversationId, kind: 'conversation', id: owned.context.conversationId };
        await store.temporary.commitTransition({ expected: [{ key: conversationKey, revision: null }], records: [
            { key: conversationKey, revision: 1, value: { principalId: owned.context.principalId, state: 'open', retention: owned.context.retention } },
        ] });
        for (let offset = 0; offset < 205; offset += 40) {
            const records = Array.from({ length: Math.min(40, 205 - offset) }, (_, index) => ({
                key: { conversationId: owned.context.conversationId, kind: 'control', id: `a-owned-control-${String(offset + index).padStart(3, '0')}` },
                revision: 1, value: { type: 'owned_normal_control', position: offset + index },
            }));
            await store.temporary.commitTransition({ expected: records.map(record => ({ key: record.key, revision: null })), records });
        }
        let original;
        if (withPending) {
            const at = new Date().toISOString();
            original = await pendingTools.put({ pendingToolId: randomUUID(), approvalId: null, executionEpoch: 1,
                revision: 0, state: 'awaiting_approval', createdAt: at, updatedAt: at,
                expiresAt: new Date(Date.now() + 60_000).toISOString(), frozen: { ...owned.context,
                    signal: undefined, name: 'ordinary_owned_tool', args: {}, argsHash: 'ordinary-owned-arguments',
                    originalRunEpoch: 1, stepId: randomUUID(), callId: randomUUID(), providerCallId: null,
                    protectedPaths: [], approvalRequiredTools: [] } }, null);
        }
        let pages = 0;
        const list = pendingTools.list.bind(pendingTools);
        pendingTools.list = async query => { pages++; return list(query); };
        assert.equal(await owned.router.confirmReleased(owned.context), withPending ? 'unconfirmed' : 'not_needed');
        assert.ok(pages >= 3);
        assert.deepEqual(owned.calls, withPending ? [] : ['local-cache', 'schema-cache']);
        if (original) assert.deepEqual(await pendingTools.get(original.pendingToolId), original);
    } finally {
        await store.close();
        const resolved = resolve(directory);
        assert.ok(resolved.startsWith(resolve(tmpdir()) + sep));
        await rm(resolved, { recursive: true, force: true });
    }
});

test('a repeated pending cursor stays unconfirmed without touching resource adapters', async () => {
    const owned = fixture();
    let reads = 0;
    owned.router.pendingTools.list = async () => { reads++; return { items: [], nextCursor: 'same-owned-cursor' }; };
    assert.equal(await owned.router.confirmReleased(owned.context), 'unconfirmed');
    assert.equal(reads, 2);
    assert.deepEqual(owned.calls, []);
});

test('a failed pending page stays unconfirmed without touching resource adapters', async () => {
    const owned = fixture();
    owned.router.pendingTools.list = async () => { throw new Error('owned pending read is unavailable'); };
    assert.equal(await owned.router.confirmReleased(owned.context), 'unconfirmed');
    assert.deepEqual(owned.calls, []);
});
