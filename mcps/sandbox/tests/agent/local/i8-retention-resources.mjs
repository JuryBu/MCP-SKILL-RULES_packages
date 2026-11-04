import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WebResourceStore } from '../../../src/agent-server/resources/web-resource-store.ts';
import { MemoryResourceStore, ResourceRegistry } from '../../../src/agent-server/resources/registry.ts';
import { openAgentStore } from '../../../src/agent-server/storage/index.ts';
import { MemoryStore } from '../../../src/agent-server/storage/memory.ts';
import { TemporaryMemoryBudget } from '../../../src/agent-server/media/temporary-budget.ts';

async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'sa-i8-retention-'));
    const dataDir = join(root, 'state');
    let store = await openAgentStore({ dataDir });
    const closedAt = new Date(Date.now() - 120000).toISOString();
    const record = (conversationId, mode = 'ttl', parentConversationId) => ({
        key: { conversationId, kind: 'conversation', id: conversationId }, revision: 1, value: {
            conversationId, principalId: 'owned-i8-retention', state: 'closed',
            options: parentConversationId ? { parentConversationId } : {}, policyRevision: 1, historyEpoch: 1,
            workspaceRevision: 0, runEpoch: 0, appendSeq: 0, viewRevision: 0,
            createdAt: closedAt, updatedAt: closedAt, cleanupState: 'released', closeCleanupCompleted: true,
            retention: { mode, ...(mode === 'ttl' ? { ttlDurationMs: 60000 } : {}), activeRuns: 0,
                lastClose: closedAt, lastRunEnd: null, expiresAt: null },
        } });
    return { root, get store() { return store; }, record,
        async add(records, contents = []) {
            await store.commitTransition({ expected: records.map(item => ({ key: item.key, revision: null })), records, contents });
        },
        inspect(sql, ...parameters) {
            const database = new DatabaseSync(join(dataDir, 'catalog.sqlite'), { readOnly: true });
            try { return database.prepare(sql).all(...parameters); }
            finally { database.close(); }
        },
        async reopen() { await store.close(); store = await openAgentStore({ dataDir }); },
        async close() {
            await store.close();
            const target = await realpath(root);
            assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
            assert.ok(basename(target).startsWith('sa-i8-retention-'));
            await rm(target, { recursive: true, force: true });
        } };
}

function commandResource(conversationId, mode = 'ttl', released = false) {
    const output = Buffer.from('owned command output\n'.repeat(3500));
    return { resourceId: randomUUID(), issuerId: 'owned-i8', principalId: 'owned-i8-retention',
        conversationId, runId: randomUUID(), rootRunId: randomUUID(), runEpoch: 1,
        actionId: randomUUID(), requestId: randomUUID(), argsHash: 'owned-command-output', adapterId: 'native.command', kind: 'process',
        leaseUntil: new Date(Date.now() + 60000).toISOString(), state: released ? 'released' : 'unresolved',
        cleanupState: released ? 'released' : 'unconfirmed', retention: { mode, ...(mode === 'ttl' ? { ttlDurationMs: 60000 } : {}) },
        receipt: { started: true, terminalConfirmed: released, released, evidence: {
            terminalConfirmed: released, cleanupState: released ? 'released' : 'unconfirmed',
            output: { encoding: 'base64', stdoutBase64: output.toString('base64'), stderrBase64: '',
                retainedBytes: output.length, observedBytes: output.length, truncated: false },
        } } };
}

test('I8 expired 202-member family advances by 200-child pages and resumes the persisted cursor after reopen', async () => {
    const owned = await fixture();
    try {
        const parentId = randomUUID();
        const archiveId = randomUUID();
        const children = Array.from({ length: 201 }, () => randomUUID());
        const shared = { attachment: 'data:application/octet-stream;base64,' + Buffer.from('owned shared media').toString('base64') };
        const contentId = randomUUID();
        await owned.add([owned.record(parentId), owned.record(archiveId, 'archive')], [
            { conversationId: parentId, contentId: randomUUID(), kind: 'attachment', value: shared },
            { conversationId: archiveId, contentId, kind: 'attachment', value: shared },
        ]);
        for (let offset = 0; offset < children.length; offset += 40) {
            const page = children.slice(offset, offset + 40);
            await owned.add(page.map(childId => owned.record(childId, 'ttl', parentId)),
                page.map(childId => ({ conversationId: childId, contentId: randomUUID(), kind: 'input', value: { text: `owned child ${childId}` } })));
        }
        const first = await owned.store.persistent.sweepRetention({ limit: 1, maxFiles: 10 });
        assert.equal(first.conversations.length, 1);
        assert.equal(first.conversations[0].state, 'deferred');
        assert.equal(first.conversations[0].reason, 'family_page_pending');
        assert.equal(first.conversations[0].conversationIds.length, 200);
        assert.ok(!first.conversations[0].conversationIds.includes(parentId));
        assert.equal(owned.inspect("SELECT COUNT(*) AS total FROM server_state WHERE kind='retentionPurgeCursor' AND id=?", parentId)[0].total, 1);
        assert.equal(owned.inspect("SELECT COUNT(*) AS total FROM conversations WHERE state='deleted'")[0].total, 200);
        assert.deepEqual(await owned.store.readContent(archiveId, contentId), shared);
        await owned.reopen();
        const last = await owned.store.persistent.sweepRetention({ limit: 1, maxFiles: 200 });
        assert.equal(last.conversations[0].state, 'deleted');
        assert.equal(last.conversations[0].conversationIds.length, 2);
        assert.ok(last.conversations[0].conversationIds.includes(parentId));
        assert.equal(owned.inspect("SELECT COUNT(*) AS total FROM server_state WHERE kind='retentionPurgeCursor' AND id=?", parentId)[0].total, 0);
        assert.equal(owned.inspect("SELECT COUNT(*) AS total FROM conversations WHERE state='deleted'")[0].total, 202);
        assert.equal(owned.inspect("SELECT COUNT(*) AS total FROM content_items WHERE cid<>?", archiveId)[0].total, 0);
        assert.deepEqual(await owned.store.readContent(archiveId, contentId), shared);
        let garbage = last.garbage;
        for (let page = 0; garbage.pending > garbage.retained && page < 3; page++) garbage = (await owned.store.persistent.sweepRetention({ limit: 1, maxFiles: 200 })).garbage;
        assert.equal(garbage.pending, garbage.retained);
        assert.deepEqual(garbage.failures, []);
        console.log(JSON.stringify({ evidence: 'I8-retention-paged', familySize: 202, firstDeleted: 200, resumedDeleted: 2,
            persistedCursor: true, sharedArchiveMediaPreserved: true, pendingGarbage: garbage.pending, referencedObjectsRetained: garbage.retained,
            fixtureClock: 'closed-at-two-minutes-before-start', paidRequests: 0 }));
    } finally { await owned.close(); }
});

test('I8 TTL keeps pending command output then removes its released resource, operation and chunks from both tables', async () => {
    const owned = await fixture();
    try {
        const conversationId = randomUUID();
        const archiveId = randomUUID();
        await owned.add([owned.record(conversationId), owned.record(archiveId, 'archive')]);
        let resources = new WebResourceStore(owned.store.persistent, { adapterIds: ['native.command'] });
        const command = commandResource(conversationId);
        const archive = commandResource(archiveId, 'archive', true);
        await resources.allocate(command);
        await resources.allocate(archive);
        const chunks = owned.inspect("SELECT value_json FROM store_records WHERE record_id GLOB 'web-resource-command-output:*' AND json_extract(value_json,'$.resourceId')=?", command.resourceId);
        assert.ok(chunks.length > 1);
        assert.ok(chunks.every(chunk => JSON.parse(chunk.value_json).conversationId === conversationId));
        const blocked = await owned.store.persistent.sweepRetention({ limit: 1, maxFiles: 10 });
        assert.equal(blocked.conversations[0].state, 'deferred');
        assert.equal(blocked.conversations[0].reason, 'web_resource_cleanup_pending');
        await owned.reopen();
        resources = new WebResourceStore(owned.store.persistent, { adapterIds: ['native.command'] });
        const original = await resources.get(command.resourceId);
        assert.equal(original.receipt.evidence.output.stdoutBase64, command.receipt.evidence.output.stdoutBase64);
        const released = { ...original, state: 'released', cleanupState: 'released', receipt: {
            started: true, terminalConfirmed: true, released: true, evidence: { terminalConfirmed: true, cleanupState: 'released' } } };
        await resources.put(released);
        const plan = await resources.retentionRemovalPlan([conversationId]);
        assert.ok(plan.remove.length >= chunks.length + 2);
        assert.deepEqual(plan.deferredResourceIds, []);
        const removed = await owned.store.persistent.sweepRetention({ limit: 1, maxFiles: 10 });
        assert.equal(removed.conversations[0].state, 'deleted');
        for (const [table, identity] of [['store_records', 'record_id'], ['server_state', 'id']]) {
            assert.equal(owned.inspect(`SELECT COUNT(*) AS total FROM ${table} WHERE ${identity} GLOB 'web-resource*' AND json_extract(value_json,'$.conversationId')=?`, conversationId)[0].total, 0);
        }
        await owned.reopen();
        resources = new WebResourceStore(owned.store.persistent, { adapterIds: ['native.command'] });
        assert.equal(await resources.get(command.resourceId), undefined);
        assert.ok(await resources.get(archive.resourceId));
        console.log(JSON.stringify({ evidence: 'I8-command-ttl', pendingRetainedAcrossReopen: true,
            releasedOutputChunks: chunks.length, bothTablesRemoved: true, archiveResourcePreserved: true,
            fixtureClock: 'closed-at-two-minutes-before-start', launchedProcesses: 0, paidRequests: 0 }));
    } finally { await owned.close(); }
});

test('I8 resource status pages remain bounded and leave command originals available by resource ID', async () => {
    const owned = await fixture();
    try {
        const conversationId = randomUUID();
        const rootRunId = randomUUID();
        await owned.add([owned.record(conversationId, 'archive')]);
        const resources = new WebResourceStore(owned.store.persistent, { adapterIds: ['native.command'] });
        const originals = Array.from({ length: 3 }, () => ({ ...commandResource(conversationId, 'archive', true), rootRunId }));
        for (const resource of originals) await resources.allocate(resource);
        const found = [];
        const seen = new Set();
        let cursor;
        let pages = 0;
        do {
            const page = await resources.listMetadataPage(conversationId, rootRunId, { cursor, limit: 2 });
            pages++;
            assert.ok(page.resources.length <= 2);
            assert.ok(page.resources.every(resource => resource.receipt.evidence.output === undefined));
            found.push(...page.resources.map(resource => resource.resourceId));
            cursor = page.nextCursor;
            if (cursor) { assert.ok(!seen.has(cursor)); seen.add(cursor); }
        } while (cursor);
        assert.deepEqual(found.sort(), originals.map(resource => resource.resourceId).sort());
        assert.ok(pages > 2);
        assert.equal((await resources.get(originals[0].resourceId)).receipt.evidence.output.stdoutBase64,
            originals[0].receipt.evidence.output.stdoutBase64);
    } finally { await owned.close(); }
});

test('I8 closing released temporary command resources frees their actual memory budget and original output', async () => {
    const port = new MemoryStore();
    try {
        const budget = new TemporaryMemoryBudget();
        const fallback = new MemoryResourceStore();
        fallback.list = async () => { assert.fail('budgeted temporary status pages must not clone all original output'); };
        const resources = new WebResourceStore(port, { adapterIds: ['native.command'], fallback, temporaryBudget: budget.scope('i8-command-resources') });
        const resource = commandResource(randomUUID(), 'temporary', true);
        await resources.allocate(resource);
        assert.ok(budget.usage(resource.conversationId).totalBytes > 0);
        const page = await resources.listMetadataPage(resource.conversationId, resource.rootRunId, { limit: 1 });
        assert.equal(page.resources.length, 1);
        assert.equal(page.resources[0].receipt.evidence.output, undefined);
        await resources.forgetTemporaryConversation(resource.conversationId, await resources.listTemporaryConversation(resource.conversationId));
        assert.equal(await resources.get(resource.resourceId), undefined);
        assert.equal(budget.usage().totalBytes, 0);
        assert.equal((await port.listRecords({ kind: 'control', conversationId: null })).items.length, 0);
    } finally { await port.close(); }
});

test('I8 budget-enabled status pages also include ordinary archived fallback resources', async () => {
    const port = new MemoryStore();
    try {
        const resources = new WebResourceStore(port, { adapterIds: ['native.command'],
            temporaryBudget: new TemporaryMemoryBudget().scope('i8-fallback-resources') });
        const resource = { ...commandResource(randomUUID(), 'archive', true), adapterId: 'owned-local-resource' };
        await resources.allocate(resource);
        const page = await resources.listMetadataPage(resource.conversationId, resource.rootRunId, { limit: 1 });
        assert.deepEqual(page.resources.map(item => item.resourceId), [resource.resourceId]);
    } finally { await port.close(); }
});

test('I8 registry closes sparse resource pages without retaining output or closing another child run', async () => {
    const port = new MemoryStore();
    try {
        const resources = new WebResourceStore(port, { adapterIds: ['native.command'] });
        resources.list = async () => { assert.fail('paged registry cleanup must not request a complete resource list'); };
        const registry = new ResourceRegistry(resources, 'owned-i8-registry');
        const released = [];
        const output = Buffer.from('owned source-level adapter output');
        registry.register({ adapterId: 'native.command', supports: { authenticated: true, findByRequest: true,
            finiteLease: true, status: true, renew: true, cancel: true, release: true, ephemeralContent: true },
            async create() { return { started: true, terminalConfirmed: false, released: false, evidence: {
                output: { encoding: 'base64', stdoutBase64: output.toString('base64'), stderrBase64: '',
                    retainedBytes: output.length, observedBytes: output.length, truncated: false } } }; },
            async findByRequest(resource) { return resource.receipt; }, async status(resource) { return resource.receipt; },
            async renew(resource) { return resource.receipt; }, async cancel(resource) { return resource.receipt; },
            async release(resource) {
                released.push(resource.resourceId);
                return { ...resource.receipt, terminalConfirmed: true, released: true,
                    evidence: { ...resource.receipt.evidence, terminalConfirmed: true, cleanupState: 'released' } };
            } });
        const rootRunId = randomUUID();
        const firstRunId = randomUUID();
        const secondRunId = randomUUID();
        const context = { principalId: 'owned-i8-registry', conversationId: randomUUID(), runId: rootRunId, rootRunId,
            runEpoch: 1, roundId: randomUUID(), attemptId: randomUUID(), policyRevision: 1, roots: [], retention: { mode: 'archive' },
            signal: new AbortController().signal };
        const originals = [];
        for (let index = 0; index < 205; index++) {
            const bound = { ...context, runId: index % 2 === 0 ? firstRunId : secondRunId, actionId: randomUUID() };
            originals.push(await registry.create('native.command', 'process', { ordinary: index }, bound));
        }
        const first = await registry.closeRun({ ...context, runId: firstRunId });
        assert.equal(first.length, 103);
        assert.ok(first.every(resource => resource.runId === firstRunId && resource.state === 'released' && !resource.receipt.evidence.output));
        assert.equal(released.length, 103);
        const remaining = originals.find(resource => resource.runId === secondRunId);
        assert.equal((await resources.get(remaining.resourceId)).state, 'active');
        assert.equal((await resources.get(first[0].resourceId)).receipt.evidence.output.stdoutBase64, output.toString('base64'));
        const all = await registry.releaseIdle(context);
        assert.equal(all.length, 205);
        assert.ok(all.every(resource => resource.state === 'released' && resource.receipt.evidence.output === undefined));
        assert.equal(new Set(released).size, 205);
        console.log(JSON.stringify({ evidence: 'I8-registry-paged', sourceLevelMetadataAdapter: true, resourceCount: 205,
            childClosed: 103, otherChildPreservedUntilRootClose: true, sparsePagesConsumed: true,
            originalOutputRetained: true, accumulatedResultsMetadataOnly: true, sharedMcpShutdownCalls: 0 }));
    } finally { await port.close(); }
});
