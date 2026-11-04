import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { selectChildTools } from '../../../src/agent-server/delegation/tool-policy.ts';
import { openAgentStore, createAgentWorkspacePorts } from '../../../src/agent-server/storage/index.ts';
import { ToolRouter } from '../../../src/agent-server/tools/router.ts';
import { withDeclaredCommandWrites } from '../../../src/agent-server/workspace/command-writes.ts';
import { createAgentWorkspaceRestoreCore } from '../../../src/agent-server/workspace/history.ts';
import { WorkspaceCoordinator } from '../../../src/agent-server/workspace/journal.ts';
import { collectRoundChildChanges, mergeRestoreActions, readJournalActions } from '../../../src/agent-server/workspace/round-children.ts';
import { WorkspaceChangesService } from '../../../src/agent-server/workspace/service.ts';

async function fixture(mode = 'temporary') {
    const root = await mkdtemp(join(tmpdir(), 'sa-i8-workspace-'));
    const roots = [join(root, '资料 一'), join(root, '资料 二')];
    await Promise.all(roots.map(directory => mkdir(directory)));
    const dataDir = join(root, 'private-state');
    const store = await openAgentStore({ dataDir });
    const ports = createAgentWorkspacePorts(store);
    const coordinator = new WorkspaceCoordinator();
    const router = new ToolRouter({ journal: ports.journal, coordinator });
    const conversationId = randomUUID();
    const childId = randomUUID();
    const runId = randomUUID();
    const childRunId = randomUUID();
    const roundId = randomUUID();
    const dispatchActionId = randomUUID();
    const now = new Date().toISOString();
    const retention = { mode };
    const records = [];
    for (const [ownedId, ownedRun, parentRun] of [[conversationId, runId, null], [childId, childRunId, runId]]) {
        records.push({ key: { conversationId: ownedId, kind: 'conversation', id: ownedId }, revision: 1, value: {
            conversationId: ownedId, principalId: 'owned-i8', state: 'open', options: { writeRoots: roots,
                ...(parentRun ? { parentConversationId: conversationId, parentRoundId: roundId, parentActionId: dispatchActionId } : {}) },
            retention: { ...retention, lastRunEnd: null, lastClose: null, expiresAt: null, activeRuns: 1 },
            createdAt: now, updatedAt: now, historyEpoch: 1, appendSeq: 0, viewRevision: 0, workspaceRevision: 0,
            runEpoch: 1, activeRunId: ownedRun, eventGeneration: randomUUID(), eventSeq: '0', policyRevision: 1, configRevision: 1,
        } });
        records.push({ key: { conversationId: ownedId, kind: 'run', id: ownedRun }, revision: 1, value: {
            conversationId: ownedId, runId: ownedRun, rootRunId: runId, parentRunId: parentRun, kind: 'task', runEpoch: 1,
            state: 'running', phase: 'executing_tools', resultStatus: null, stopReason: null, effectState: 'none', cleanupState: 'pending',
            activeRoundId: roundId, activeStepId: null, pendingInteractionIds: [], budget: { fixture: true },
            deadlineAt: new Date(Date.now() + 60000).toISOString(), createdAt: now, updatedAt: now,
            ...(!parentRun ? { internalChildren: [{ childConversationId: childId, childRunId, parentRoundId: roundId,
                parentActionId: dispatchActionId, callKey: JSON.stringify([dispatchActionId, dispatchActionId]) }] } : {}),
        } });
    }
    try {
        await store.commitTransition({ expected: records.slice(0, 2).map(record => ({ key: record.key, revision: null })), records: records.slice(0, 2),
            contents: [{ conversationId, contentId: randomUUID(), kind: 'input', value: { text: 'owned parent round' }, indexHistory: true,
                history: { view: 'raw', effective: true, role: 'user', roundId, runId, runEpoch: 1, stepId: null } }] });
        await store.commitTransition({ expected: records.slice(2).map(record => ({ key: record.key, revision: null })), records: records.slice(2) });
    } catch (error) {
        await store.close();
        const target = await realpath(root);
        assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
        assert.ok(basename(target).startsWith('sa-i8-workspace-'));
        await rm(target, { recursive: true, force: true });
        throw error;
    }
    const context = { conversationId, runId, rootRunId: runId, runEpoch: 1, roundId, principalId: 'owned-i8', roots,
        protectedPaths: [dataDir], retention, policyRevision: 1, actionId: randomUUID(), attemptId: randomUUID(), stepId: randomUUID(),
        signal: new AbortController().signal, async assertCurrent() {} };
    const child = { ...context, conversationId: childId, runId: childRunId, roundId: randomUUID() };
    const stopped = [];
    const core = createAgentWorkspaceRestoreCore({ store, journal: ports.journal, plans: ports.restorePlans,
        async quiesce(input) { stopped.push(...input.childConversationIds ?? []); return { async release() {} }; } });
    const service = new WorkspaceChangesService({ journal: ports.journal, files: router.files, plans: ports.restorePlans, coordinator, core });
    return { root, roots, store, ports, router, coordinator, context, child, service, stopped,
        async edit(filePath, text, owner = context) {
            const bound = { ...owner, actionId: randomUUID() };
            const read = await router.execute('read_file', { path: filePath }, bound);
            assert.equal(read.ok, true, JSON.stringify(read));
            const written = await router.execute('write_file', { path: filePath, content: text, expectedVersion: read.data.expectedVersion }, bound);
            assert.equal(written.ok, true, JSON.stringify(written));
            return bound.actionId;
        },
        async close() {
            await router.release(child);
            await router.release(context);
            await store.close();
            const target = await realpath(root);
            assert.equal(dirname(target).toLowerCase(), (await realpath(tmpdir())).toLowerCase());
            assert.ok(basename(target).startsWith('sa-i8-workspace-'));
            await rm(target, { recursive: true, force: true });
        } };
}

test('I8 local file tools inherit their current registration and preserve the default selection', () => {
    const tools = ['read_file', 'patch_file', 'move_file', 'delete_file', 'mkdir'];
    assert.deepEqual(selectChildTools({ parentTools: tools, childRetentionMode: 'temporary' }).tools, tools);
    assert.deepEqual(selectChildTools({ childRetentionMode: 'archive' }).tools, ['read_file', 'write_file', 'list_files']);
});

test('I8 declared directory and descendant file share a coordinator while independent paths proceed', async () => {
    const coordinator = new WorkspaceCoordinator();
    const root = join(tmpdir(), 'sa-i8-coordinator');
    const events = [];
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    const directory = coordinator.withPaths([join(root, 'first')], async () => { events.push('directory'); await hold; });
    const descendant = coordinator.withPaths([join(root, 'first', 'file.txt')], async () => { events.push('descendant'); });
    const independent = coordinator.withPaths([join(root, 'second', 'file.txt')], async () => { events.push('independent'); });
    try {
        await independent;
        await delay(10);
        assert.deepEqual(events, ['directory', 'independent']);
    } finally { release(); await Promise.all([directory, descendant, independent]); }
    assert.deepEqual(events, ['directory', 'independent', 'descendant']);
});

test('I8 journal selection consumes bounded pages and releases unrelated history', async () => {
    const requested = [];
    const journal = { async list() { assert.fail('whole-journal read'); }, async listPage(conversationId, input) {
        requested.push(input.cursor ?? 'first');
        return input.cursor ? { actions: [{ actionId: 'selected' }], nextCursor: null }
            : { actions: [{ actionId: 'unrelated' }], nextCursor: 'second' };
    } };
    assert.deepEqual(await readJournalActions(journal, 'owned', action => action.actionId === 'selected'), [{ actionId: 'selected' }]);
    assert.deepEqual(requested, ['first', 'second']);
});

test('I8 parent-child same-file order follows version lineage rather than dispatch order', () => {
    const filePath = join(tmpdir(), 'sa-i8-order.txt');
    const action = (actionId, beforeToken, afterToken) => ({ actionId, path: filePath,
        beforeVersion: { exists: true, versionToken: beforeToken }, afterVersion: { exists: true, versionToken: afterToken } });
    const parentFirst = action('parent-first', 'before', 'parent-first-version');
    const parentLater = action('parent-later', 'child-version', 'parent-later-version');
    const child = { ...action('child', 'parent-first-version', 'child-version'), workspaceOrigin: { actionId: 'dispatch' } };
    assert.deepEqual(mergeRestoreActions([parentFirst, parentLater], { childActions: [child],
        actionOrder: { 'parent-first': 1, 'parent-later': 3, dispatch: 2 } }).map(change => change.actionId), ['parent-first', 'child', 'parent-later']);
    assert.deepEqual(mergeRestoreActions([{ ...action('created', 'absent', 'present'), beforeVersion: { exists: false, versionToken: 'absent' } },
        action('removed', 'present', 'absent')]).map(change => change.actionId), ['created', 'removed']);
});

test('I8 fixed child-round links need no full raw-history scan', async () => {
    let listed = 0;
    const store = { async readHistory() { assert.fail('modern child links must not rescan raw history'); },
        async listRecords() { return { items: [{ key: { id: 'parent-run' }, value: { internalChildren: [
            { childConversationId: 'child', parentRoundId: 'round', parentActionId: 'dispatch' }] } }], nextCursor: null }; },
        async getRecord() { return { value: { principalId: 'owned', options: { parentConversationId: 'parent' } } }; } };
    const journal = { async revision() { return 1; }, async list() { assert.fail('whole child journal'); },
        async listPage() { listed++; return { actions: [{ actionId: 'change', conversationId: 'child', roundId: 'child-round' }], nextCursor: null }; } };
    const result = await collectRoundChildChanges(store, journal, { conversationId: 'parent', principalId: 'owned' }, ['round'], 1);
    assert.equal(listed, 1);
    assert.equal(result.childActions[0].sourceRoundId, 'child-round');
    assert.equal(result.childActions[0].roundId, 'round');
    assert.deepEqual(result.childRevisions, { child: 1 });
});

test('I8 older child links recover their parent round from bounded original-history pages', async () => {
    const cursors = [];
    const store = { async readHistory(input) {
        cursors.push(input.cursor ?? 'first');
        return input.cursor ? { items: [{ actionId: 'dispatch', roundId: 'parent-round', seq: 20 }], nextCursor: null }
            : { items: [{ actionId: 'earlier', roundId: 'earlier-round', seq: 1 }], nextCursor: 'next' };
    }, async listRecords() { return { items: [{ key: { id: 'parent-run' }, value: { internalChildren: [
        { childConversationId: 'child', callKey: JSON.stringify(['dispatch', 'original-call']) }] } }], nextCursor: null }; },
    async getRecord() { return { value: { principalId: 'owned', options: { parentConversationId: 'parent', parentRunId: 'parent-run' } } }; } };
    const journal = { async revision() { return 1; }, async listPage() {
        return { actions: [{ actionId: 'change', conversationId: 'child', roundId: 'child-round' }], nextCursor: null };
    } };
    const result = await collectRoundChildChanges(store, journal, { conversationId: 'parent', principalId: 'owned' }, ['parent-round'], 1);
    assert.deepEqual(cursors, ['first', 'next']);
    assert.equal(result.childActions[0].roundId, 'parent-round');
    assert.equal(result.actionOrder.dispatch, 20);
});

for (const mode of ['temporary', 'archive']) test(`I8 ${mode} parent round restores its child changes and keeps an independent later edit`, async () => {
    const owned = await fixture(mode);
    try {
        const filePath = join(owned.roots[0], '共同资料.txt');
        const initial = 'title\nold first\na\nb\nc\nd\nold last\nend\n';
        await writeFile(filePath, initial);
        await owned.edit(filePath, initial.replace('old first', 'parent first'));
        const childPath = process.platform === 'win32' ? filePath.toUpperCase() : filePath;
        const childAction = await owned.edit(childPath, initial.replace('old first', 'child first'), owned.child);
        await owned.edit(filePath, initial.replace('old first', 'parent later'));
        await writeFile(filePath, initial.replace('old first', 'parent later').replace('old last', 'human last'));
        const preview = await owned.service.preview({ mode: 'round_restart', roundId: owned.context.roundId,
            expectedHistoryEpoch: 1, expectedWorkspaceRevision: 2 }, owned.context);
        assert.ok(preview.actionIds.includes(childAction));
        assert.deepEqual(preview.childConversationIds, [owned.child.conversationId]);
        const restored = await owned.service.commit({ restorePlanId: preview.restorePlanId, clientCommandId: randomUUID() }, owned.context);
        assert.equal(restored.state, 'complete', JSON.stringify(restored));
        assert.equal(restored.results[0].status, 'restored', JSON.stringify(restored));
        assert.equal(await readFile(filePath, 'utf8'), initial.replace('old last', 'human last'));
        assert.deepEqual(owned.stopped, [owned.child.conversationId]);
        assert.equal((await owned.ports.journal.get(owned.child.conversationId, childAction)).state, 'applied');
        assert.equal((await owned.store.readHistory({ conversationId: owned.context.conversationId, view: 'raw', effectiveOnly: false })).items.length, 1);
    } finally { await owned.close(); }
});

for (const mode of ['temporary', 'archive']) test(`I8 ${mode} real ordinary command records two write roots and can restore both declared files`, async () => {
    const owned = await fixture(mode);
    try {
        const first = join(owned.roots[0], 'existing.txt');
        const second = join(owned.roots[1], 'created.txt');
        await writeFile(first, 'before command\n');
        owned.router.commands.bindWorkspace({ journal: owned.ports.journal, files: owned.router.files, coordinator: owned.coordinator });
        const script = `require('node:fs').writeFileSync(${JSON.stringify(first)}, 'after command\\n'); require('node:fs').writeFileSync(${JSON.stringify(second)}, 'created by command\\n'); console.log('owned command');`;
        const receipt = await owned.router.commands.execute({ application: process.execPath, args: ['-e', script], cwd: owned.roots[0],
            timeoutMs: 5000, maxMemoryMB: 128, maxOutputBytes: 8192, writeSet: [first, second] }, owned.context, owned.router.resources);
        assert.equal(receipt.terminalConfirmed, true);
        assert.equal(receipt.childExitCode, 0);
        assert.equal(receipt.coverage.actionIds.length, 2);
        assert.equal(receipt.coverage.restoreSupport, 'partial');
        for (const actionId of receipt.coverage.actionIds) {
            const action = await owned.ports.journal.get(owned.context.conversationId, actionId);
            assert.equal(action.commandActionId, owned.context.actionId);
            assert.equal(action.state, 'applied');
            assert.equal(action.settledAt, action.receipt.committedAt);
            assert.equal(action.receipt.commandObservation, undefined);
        }
        const preview = await owned.service.preview({ mode: 'files_only', actionIds: receipt.coverage.actionIds,
            expectedHistoryEpoch: 1, expectedWorkspaceRevision: 2 }, owned.context);
        const restored = await owned.service.commit({ restorePlanId: preview.restorePlanId, clientCommandId: randomUUID() }, owned.context);
        assert.equal(restored.state, 'complete', JSON.stringify(restored));
        assert.ok(restored.results.every(result => result.status === 'restored'), JSON.stringify(restored));
        assert.equal(await readFile(first, 'utf8'), 'before command\n');
        await assert.rejects(readFile(second), { code: 'ENOENT' });
    } finally { await owned.close(); }
});

test('I8 normal declared directory reports incomplete capture instead of a complete file journal', async () => {
    const owned = await fixture();
    try {
        const result = await withDeclaredCommandWrites({ journal: owned.ports.journal, files: owned.router.files,
            coordinator: owned.coordinator }, [owned.roots[0]], owned.context, 'a'.repeat(64), async () => {
                await writeFile(join(owned.roots[0], 'ordinary-output.txt'), 'owned output');
                return { terminalConfirmed: true, cleanupState: 'released', coverage: {} };
            });
        assert.deepEqual(result.coverage.actionIds, []);
        assert.equal(result.coverage.restoreSupport, 'partial');
        assert.equal(result.coverage.omitted[0].reason, 'directory_effects_untracked');
    } finally { await owned.close(); }
});
