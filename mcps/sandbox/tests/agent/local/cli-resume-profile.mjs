import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { parseArguments } from '../../../src/agent-cli/arguments.ts';
import { executeCommand, parseCommand } from '../../../src/agent-cli/commands.ts';
import { refreshSavedProfileCatalog } from '../../../src/agent-cli/configuration-commands.ts';
import { interactiveResultLines } from '../../../src/agent-cli/ui-results.ts';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';

function profile(revision = 4) {
    return { profileId: 'fixture-provider', revision, label: 'Fixture API', credentialRef: 'fixture-protected-reference',
        protocol: 'compatible_chat', parameterDefaults: { maxOutputTokens: 2048 } };
}

function clientFixture(request) {
    const calls = [];
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd(), request: async (method, params, options) => {
        calls.push({ method, params: structuredClone(params), options }); return request(method, params, options);
    } });
    return { client, calls };
}

function runCommand(client, args, signal) {
    return executeCommand(parseCommand(parseArguments(args)), { client, cwd: process.cwd(), conversationId: 'fixture-conversation',
        readInput: async () => undefined, signal });
}

function uiFixture(request) {
    const { client, calls } = clientFixture(request);
    const output = new Writable({ write(_bytes, _encoding, done) { done(); } });
    const ui = new InteractiveCli({ words: [], options: { plain: true } }, client,
        { stdin: Readable.from([]), stdout: output, stderr: output, cwd: process.cwd() });
    return { ui, client, calls };
}

test('resume reads current run and conversation versions rather than using epoch one', async () => {
    const { client, calls } = clientFixture(async method => ({ ok: true, data: method === 'runs.get' ? { runEpoch: 2 }
        : method === 'conversations.get' ? { historyEpoch: 1 } : { state: 'running' } }));
    const result = await runCommand(client, ['runs', 'resume', 'fixture-run']);
    assert.equal(result.result.ok, true);
    assert.deepEqual(calls.map(call => call.method), ['runs.get', 'conversations.get', 'runs.resume']);
    assert.equal(calls[2].params.expectedRunEpoch, 2); assert.equal(calls[2].params.expectedHistoryEpoch, 1);
});

test('resume preserves both explicit versions and avoids implicit snapshot reads', async () => {
    const { client, calls } = clientFixture(async () => ({ ok: true, data: {} }));
    await runCommand(client, ['runs', 'resume', 'fixture-run', '--run-epoch', '7', '--history-epoch', '5']);
    assert.equal(calls.length, 1); assert.equal(calls[0].params.expectedRunEpoch, 7); assert.equal(calls[0].params.expectedHistoryEpoch, 5);
});

test('resume fills only the omitted version and retains explicit params values', async () => {
    const { client, calls } = clientFixture(async () => ({ ok: true, data: { runEpoch: 9 } }));
    await runCommand(client, ['runs', 'resume', 'fixture-run', '--params', JSON.stringify({ expectedHistoryEpoch: 0 })]);
    assert.deepEqual(calls.map(call => call.method), ['runs.get', 'runs.resume']);
    assert.equal(calls[1].params.expectedRunEpoch, 9); assert.equal(calls[1].params.expectedHistoryEpoch, 0);
});

test('resume snapshot failure stops before mutation without automatic retry', async () => {
    const failure = { ok: false, error: { code: 'NOT_FOUND', message: '原执行不存在', mayHaveStarted: false } };
    const { client, calls } = clientFixture(async method => method === 'runs.get' ? failure : { ok: true, data: { historyEpoch: 1 } });
    const result = await runCommand(client, ['runs', 'resume', 'fixture-run']);
    assert.equal(result.method, 'runs.get'); assert.equal(result.result, failure);
    assert.equal(calls.some(call => call.method === 'runs.resume'), false);
});

test('resume rejects incomplete current snapshots instead of inventing versions', async () => {
    const { client, calls } = clientFixture(async () => ({ ok: true, data: {} }));
    await assert.rejects(runCommand(client, ['runs', 'resume', 'fixture-run']), /runEpoch/);
    assert.equal(calls.some(call => call.method === 'runs.resume'), false);
});

test('saving profile revision four refreshes its catalog before returning the original successful receipt', async () => {
    const saved = { ok: true, receiptId: 'fixture-save-receipt', data: { profile: profile(), replayed: false } };
    const { client, calls } = clientFixture(async method => method === 'profiles.put' ? saved
        : { ok: true, data: { catalog: { profileRevision: 4 }, entryCount: 1 } });
    const result = await runCommand(client, ['profile', 'put', '--params', JSON.stringify({ profile: profile(3), expectedRevision: 3 })]);
    assert.deepEqual(calls.map(call => call.method), ['profiles.put', 'models.refresh']);
    assert.deepEqual(calls[1].params, { profileId: 'fixture-provider' });
    assert.notEqual(calls[1].options.clientCommandId, calls[0].options.clientCommandId);
    assert.equal(result.result.receiptId, saved.receiptId); assert.equal(result.result.data.profile.revision, 4);
    assert.equal(result.result.data.catalogRefresh.profileRevision, 4);
    assert.equal(result.result.data.catalogRefresh.result.ok, true);
});

test('failed metadata refresh keeps saved configuration successful and explains the remaining work', async () => {
    const { client, calls } = clientFixture(async method => method === 'profiles.put'
        ? { ok: true, receiptId: 'fixture-save', data: { profile: profile() } }
        : { ok: false, error: { code: 'E_CATALOG_UNAVAILABLE', message: '目录服务暂不可达', mayHaveStarted: false } });
    const result = await runCommand(client, ['profile', 'put', '--params', JSON.stringify({ profile: profile(3), expectedRevision: 3 })]);
    assert.equal(result.result.ok, true); assert.equal(result.result.receiptId, 'fixture-save');
    assert.match(interactiveResultLines(result).join('\n'), /配置已保存.*尚未刷新[\s\S]*目录服务暂不可达/);
    assert.equal(calls.length, 2);
});

test('unknown metadata refresh retains its own original command and never invokes generation', async () => {
    const { client, calls } = clientFixture(async () => { throw new Error('connection reset'); });
    const result = await refreshSavedProfileCatalog(client, { ok: true, receiptId: 'fixture-saved', data: { profile: profile() } });
    assert.equal(result.ok, true); assert.equal(result.data.catalogRefresh.result.error.mayHaveStarted, true);
    assert.equal(result.data.catalogRefresh.clientCommandId, calls[0].options.clientCommandId);
    assert.deepEqual(calls.map(call => call.method), ['models.refresh']);
});

test('new profile without a Key and unsuccessful writes do not attempt network metadata calls', async () => {
    const { client, calls } = clientFixture(async () => { throw new Error('unexpected request'); });
    const noKey = { ok: true, data: { profile: { ...profile(), credentialRef: null } } };
    const rejected = { ok: false, error: { code: 'E_PROFILE_CONFLICT' } };
    assert.equal(await refreshSavedProfileCatalog(client, noKey), noKey);
    assert.equal(await refreshSavedProfileCatalog(client, rejected), rejected);
    assert.equal(calls.length, 0);
});

test('server-side secret import shape also refreshes its new catalog revision', async () => {
    const { client, calls } = clientFixture(async () => ({ ok: true, data: {} }));
    const result = await refreshSavedProfileCatalog(client, { ok: true, data: { profileId: 'fixture-provider', revision: 4, configured: true } });
    assert.equal(result.data.catalogRefresh.profileRevision, 4); assert.equal(calls[0].method, 'models.refresh');
});

test('cancellation after save preserves the receipt without starting metadata refresh', async () => {
    const abort = new AbortController(); abort.abort();
    const { client, calls } = clientFixture(async () => ({ ok: true }));
    const result = await refreshSavedProfileCatalog(client, { ok: true, receiptId: 'saved-before-cancel', data: { profile: profile() } }, abort.signal);
    assert.equal(result.ok, true); assert.equal(result.receiptId, 'saved-before-cancel');
    assert.equal(result.data.catalogRefresh.result.error.mayHaveStarted, false); assert.equal(calls.length, 0);
});

test('profile save receipt recovery refreshes metadata once and preserves the conversation draft', async () => {
    const { ui, client, calls } = uiFixture(async method => method === 'profiles.put'
        ? { ok: false, error: { code: 'RECEIPT_UNKNOWN', mayHaveStarted: true } } : { ok: true, data: {} });
    let receiptReads = 0;
    client.getReceipt = async () => { receiptReads += 1; return { ok: true, data: { result: { ok: true, data: { profile: profile() } } } }; };
    const args = ['profile', 'put', '--params', JSON.stringify({ profile: profile(3), expectedRevision: 3 })];
    try {
        ui.draft.replace('配置修改期间还没发送的正文');
        await ui.perform(args); await ui.perform(args);
        assert.equal(receiptReads, 1); assert.equal(calls.filter(call => call.method === 'profiles.put').length, 1);
        assert.equal(calls.filter(call => call.method === 'models.refresh').length, 1);
        assert.equal(ui.draft.text, '配置修改期间还没发送的正文');
        assert.equal(ui.profileCatalogRefreshes.get('fixture-provider').profileRevision, 4);
    } finally { await ui.finish(0); }
});

test('Key save waits for metadata refresh while keeping the draft and hiding secret input', async () => {
    let completeRefresh;
    const refreshed = new Promise(resolveRefresh => { completeRefresh = resolveRefresh; });
    const { ui, calls } = uiFixture(async method => method === 'models.refresh' ? refreshed
        : { ok: true, data: method === 'profiles.setSecret' ? { profile: profile() } : { items: [] } });
    try {
        ui.conversation = { conversationId: 'fixture-conversation' }; ui.draft.replace('原始未发草稿');
        ui.keyForm({ ...profile(3), credentialRef: null }); ui.form.draft.replace('fixture-secret-not-a-key');
        const saving = ui.advanceForm(); await new Promise(resolveTurn => setImmediate(resolveTurn));
        assert.equal(ui.busy, true); await ui.sendDraft(); assert.equal(ui.draft.text, '原始未发草稿');
        assert.equal(calls.some(call => call.method === 'runs.startInteractive'), false);
        completeRefresh({ ok: true, data: { entryCount: 1 } }); await saving;
        assert.equal(ui.busy, false); assert.equal(ui.draft.text, '原始未发草稿');
        assert.doesNotMatch(ui.logs.join('\n'), /fixture-secret-not-a-key/);
        assert.equal(calls.filter(call => call.method === 'models.refresh').length, 1);
    } finally { completeRefresh?.({ ok: true, data: {} }); await ui.finish(0); }
});
