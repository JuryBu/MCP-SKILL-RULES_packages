import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { usageOverviewLines } from '../../../src/agent-cli/usage-view.ts';
import { parseCliInputReferences } from '../../../src/agent-cli/references.ts';
import { TerminalRenderer, terminalSafeText } from '../../../src/agent-cli/renderer.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';
import { historyMessage } from '../../../src/agent-cli/history-view.ts';
import { AppliedEventCursor } from '../../../src/agent-client/events.ts';
import { pickDirectory } from '../../../src/agent-cli/folder-picker.ts';
import { interactiveResultLines } from '../../../src/agent-cli/ui-results.ts';

function fixture(request) {
    const calls = [], output = [];
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd(), request: async (method, params, options) => {
        calls.push({ method, params: structuredClone(params), options });
        if (method === 'usage.overview') return { ok: true, data: overview() };
        return await request(method, params, options);
    } });
    const stream = new Writable({ write(bytes, _encoding, done) { output.push(bytes.toString()); done(); } });
    const ui = new InteractiveCli({ words: [], options: { plain: true } }, client,
        { stdin: Readable.from([]), stdout: stream, stderr: stream, cwd: process.cwd() });
    return { ui, client, calls, output };
}

function profile() { return { profileId: 'cli-fixture-provider', label: 'Fixture API', revision: 1, protocol: 'compatible_chat', credentialRef: 'fixture-reference',
    defaultModel: 'fixture-model', routePolicy: { version: 'fixture-version', allowedModels: ['fixture-model'] } }; }

function overview() { return { asOf: '2026-11-04T16:00:00Z', account: { status: 'reported', source: 'fixture account', balances: [{ currency: 'CNY', available: 12, totalUsed: 3 }] },
    conversation: { totalTokens: 120, inputTokens: 100, outputTokens: 20, cachedInputTokens: 75, cacheStatus: 'known', costs: [{ currency: 'CNY', amountMicros: 1500 }], amountStatus: 'partial' },
    providerUsage: { scope: 'local_tool', costs: [{ currency: 'CNY', amountMicros: 3200 }], amountStatus: 'known' } }; }

test('conversation update receipt without an ID remains readable and keeps internal configuration in explicit JSON', () => {
    const execution = { method: 'conversations.update', result: { ok: true, data: { revision: 2, policyRevision: 1,
        options: { title: '当前工作区', modelId: 'fixture-model', profileId: 'fixture-private-id', writeRoots: ['C:\\fixture\\workspace'] } } } };
    const text = interactiveResultLines(execution).join('\n');
    assert.match(text, /当前工作区.*[\s\S]*fixture-model[\s\S]*C:\\fixture\\workspace/);
    assert.doesNotMatch(text, /fixture-private-id|policyRevision|\{/);
    assert.match(interactiveResultLines(execution, { raw: true }).join('\n'), /fixture-private-id/);
});

test('human compact menu uses metered maintenance without a budget questionnaire or implicit output limit', async () => {
    const { ui, calls } = fixture(async () => ({ ok: true, data: { preview: {}, handle: null } }));
    try {
        ui.conversation = { conversationId: 'fixture-conversation', revision: 1 };
        ui.terminal.linear = false;
        ui.draft.replace('未发送正文'); ui.showCommands('compact');
        await ui.menu.items.find(item => item.label === '/compact').action();
        const compact = calls.find(call => call.method === 'conversations.compact');
        assert.equal(compact.params.budget.costMode, 'metered');
        assert.equal(compact.params.budget.maxOutputTokens, undefined); assert.equal(compact.params.budget.currency, undefined);
        assert.equal(ui.form, undefined); assert.equal(ui.draft.text, '未发送正文');
    } finally { await ui.finish(0); }
});

test('workspace confirmation shows only paths and effect scope while status explicitly retains the original receipt', async () => {
    const options = { title: '原对话', modelId: 'fixture-model', profileId: 'fixture-internal-profile', workingDirectory: 'C:\\fixture\\workspace', writeRoots: ['C:\\fixture\\workspace'] };
    const { ui, calls } = fixture(async method => method === 'conversations.update'
        ? { ok: true, receiptId: 'fixture-original-settings-receipt', data: { revision: 2, policyRevision: 1, options } }
        : { ok: true, data: { conversationId: 'fixture-conversation', revision: 2, options } });
    try {
        ui.conversation = { conversationId: 'fixture-conversation', revision: 1, options }; ui.draft.replace('未发送草稿');
        assert.equal(await ui.updateConversationOptions({ workingDirectory: options.workingDirectory }), true);
        assert.match(ui.details.join('\n'), /工作目录：[\s\S]*生效范围：本对话的后续请求/);
        assert.doesNotMatch(ui.details.join('\n'), /fixture-internal-profile|policyRevision|\{/);
        await ui.executeLine('/status');
        await ui.menu.items.find(item => item.label.includes('原始回执')).action();
        assert.match(ui.details.join('\n'), /fixture-original-settings-receipt[\s\S]*fixture-internal-profile/);
        const count = calls.length; await ui.executeLine('/status --json');
        assert.equal(calls.length, count); assert.match(ui.details.join('\n'), /fixture-original-settings-receipt/);
        assert.equal(ui.draft.text, '未发送草稿');
    } finally { await ui.finish(0); }
});

test('normal 91-column footer visibly offers model, workspace and settings; wider windows also show new and restore', async () => {
    const { ui } = fixture(async () => ({ ok: true, data: {} }));
    try {
        ui.terminal.output.columns = 91;
        assert.match(ui.view().hint, /^AltM模型 · AltW工作区 · AltS设置/);
        ui.terminal.output.columns = 120;
        assert.match(ui.view().hint, /AltN新对话 · AltR恢复/);
    } finally { await ui.finish(0); }
});

test('typing the status alias opens settings receipt details instead of a required runId form', async () => {
    const { ui, calls } = fixture(async () => { throw new Error('status receipt selection must remain local'); });
    try {
        ui.terminal.linear = false;
        ui.conversation = { conversationId: 'fixture-conversation' };
        ui.conversationUpdateReceipts.set('fixture-conversation', { method: 'conversations.update', result: {
            ok: true, receiptId: 'fixture-original-status-receipt', data: { revision: 2, options: { writeRoots: ['C:\\fixture\\workspace'] } },
        } });
        for (const character of '/status') await ui.handleKey({ name: 'text', text: character });
        await ui.handleKey({ name: 'enter' });
        assert.equal(ui.form, undefined); assert.equal(ui.menu.title, '状态与设置回执');
        await ui.handleKey({ name: 'down' }); await ui.handleKey({ name: 'enter' });
        assert.match(ui.details.join('\n'), /fixture-original-status-receipt/); assert.equal(calls.length, 0);
    } finally { await ui.finish(0); }
});

test('new conversation begins with providers and preserves the original draft, without budget questions', async () => {
    const { ui, calls } = fixture(async method => ({ ok: true, data: method === 'profiles.list' ? { items: [profile()] } : {} }));
    try {
        ui.draft.replace('保留原来的输入');
        await ui.newConversation('archive');
        assert.equal(calls[0].method, 'profiles.list');
        assert.equal(ui.form, undefined);
        assert.equal(ui.selectionTarget, 'new');
        assert.equal(ui.creation.title, '');
        assert.equal(ui.draft.text, '保留原来的输入');
        assert.match(ui.menu.title, /选择服务商/);
    } finally { await ui.finish(0); }
});

test('browsing provider settings never changes the current model selection', async () => {
    const { ui } = fixture(async () => ({ ok: true, data: {} }));
    try {
        ui.selectedProfile = 'original-provider'; ui.selectedModel = 'original-model';
        ui.profileMenu(profile());
        assert.equal(ui.selectedProfile, 'original-provider'); assert.equal(ui.selectedModel, 'original-model');
        ui.restoreSelection({ options: { profileId: 'restored-provider', modelId: 'restored-model' } });
        assert.equal(ui.selectedProfile, 'restored-provider'); assert.equal(ui.selectedModel, 'restored-model');
        ui.restoreSelection({ options: {} });
        assert.equal(ui.selectedProfile, undefined); assert.equal(ui.selectedModel, undefined);
    } finally { await ui.finish(0); }
});

test('new model selection advances to workspace without modifying the open conversation', async () => {
    const { ui, calls } = fixture(async method => ({ ok: true, data: method === 'profiles.get' ? profile() : {} }));
    try {
        ui.conversation = { conversationId: 'original-conversation', options: { profileId: 'original-provider' } };
        ui.selectionTarget = 'new'; ui.creation = { mode: 'archive', title: '', roots: [process.cwd()] };
        ui.setupContinuation = () => ui.creationMenu();
        await ui.selectModel('cli-fixture-provider', 'fixture-model');
        assert.equal(ui.newSelection.modelId, 'fixture-model');
        assert.equal(ui.conversation.options.profileId, 'original-provider');
        assert.equal(calls.some(call => call.method === 'conversations.update'), false);
        assert.match(ui.menu.title, /工作区/);
    } finally { await ui.finish(0); }
});

test('ordinary first send uses metered interactive RPC without a budget object', async () => {
    const { ui, calls } = fixture(async () => ({ ok: true, receiptId: 'fixture-receipt', data: { runId: 'fixture-run', state: 'running' } }));
    try {
        ui.conversation = { conversationId: 'fixture-conversation', historyEpoch: 0 };
        ui.selectedProfile = 'cli-fixture-provider'; ui.selectedModel = 'fixture-model';
        ui.draft.replace('你好，开始工作'); await ui.sendDraft();
        const submitted = calls.find(call => call.method === 'runs.startInteractive');
        assert.ok(submitted); assert.equal(submitted.params.budget, undefined);
        assert.equal(submitted.params.input.text, '你好，开始工作');
        assert.equal(ui.form, undefined); assert.equal(ui.draft.text, '');
    } finally { await ui.finish(0); }
});

test('failed first send keeps draft and does not open the budget form', async () => {
    const { ui } = fixture(async () => ({ ok: false, error: { code: 'E_MODEL_REQUIRED', message: '请选择模型', mayHaveStarted: false } }));
    try {
        ui.conversation = { conversationId: 'fixture-conversation', historyEpoch: 0 }; ui.draft.replace('首条消息');
        await ui.sendDraft(); assert.equal(ui.draft.text, '首条消息'); assert.equal(ui.form, undefined); assert.equal(ui.pendingDrafts.size, 0);
    } finally { await ui.finish(0); }
});

test('key input is hidden, non-undoable, cleared after save, and absent from transcript', async () => {
    const { ui, calls, output } = fixture(async method => ({ ok: true, receiptId: 'fixture-key-receipt', data: method === 'profiles.list' ? { items: [profile()] } : {} }));
    try {
        ui.keyForm({ ...profile(), credentialRef: null });
        ui.form.draft.replace('fixture-not-a-real-key');
        assert.equal(ui.view().hidden, true); assert.equal(ui.form.draft.sensitive, true);
        ui.form.draft.undo(); assert.equal(ui.form.draft.text, 'fixture-not-a-real-key');
        const original = ui.form; await ui.advanceForm();
        assert.equal(original.values.secret, undefined); assert.equal(original.draft.text, '');
        assert.equal(calls.filter(call => call.method === 'profiles.setSecret').length, 1);
        assert.equal(ui.history.length, 0); assert.doesNotMatch(output.join('') + ui.logs.join(''), /fixture-not-a-real-key/);
    } finally { await ui.finish(0); }
});

test('unknown key save is queried by its original command and is never resent', async () => {
    const { ui, client, calls } = fixture(async () => ({ ok: false, error: { code: 'RECEIPT_UNKNOWN', mayHaveStarted: true } }));
    client.getReceipt = async () => ({ ok: true, data: {} });
    try {
        ui.keyForm({ ...profile(), credentialRef: null }); ui.form.draft.replace('fixture-pending-key');
        await ui.advanceForm(); assert.match(ui.menu.title, /待确认/);
        await ui.menu.items[0].action();
        assert.equal(calls.filter(call => call.method === 'profiles.setSecret').length, 1);
        assert.equal(ui.form, undefined);
    } finally { await ui.finish(0); }
});

test('file reference preview adds an explicit source to draft without sending a model request', async () => {
    const { ui, calls } = fixture(async () => ({ ok: true, data: {} }));
    try {
        const path = fileURLToPath(import.meta.url);
        await ui.previewReferenceFile(path, 'L1-L3'); assert.match(ui.menu.context[0], /L1-L3/);
        await ui.menu.items[0].action();
        const parsed = parseCliInputReferences(ui.draft.text, { cwd: process.cwd() });
        assert.equal(parsed.sources[0].source, path); assert.equal(parsed.sources[0].range, '#L1-L3');
        assert.equal(calls.length, 0);
    } finally { await ui.finish(0); }
});

test('usage remains visible with cache scope, currency, partial amounts, and account provenance', () => {
    const lines = usageOverviewLines(overview());
    assert.match(lines[0], /120 token.*75\.0%.*本对话输入/);
    assert.match(lines[1], /CNY 0\.0015.*部分金额待提供.*本工具累计/);
    assert.match(lines[2], /API已用 CNY 3.*余额 12.*fixture account/);
    const empty = overview(); empty.conversation.inputTokens = 0; empty.conversation.cachedInputTokens = 0;
    assert.doesNotMatch(usageOverviewLines(empty).join(''), /NaN|Infinity/);
    const unknownCache = overview(); unknownCache.conversation.cachedInputTokens = null;
    assert.match(usageOverviewLines(unknownCache)[0], /缓存率 未提供/);
    assert.doesNotMatch(usageOverviewLines(unknownCache)[0], /0\.0%/);
    const zeroCache = overview(); zeroCache.conversation.cachedInputTokens = 0;
    assert.match(usageOverviewLines(zeroCache)[0], /缓存率 0\.0%/);
    const partialCache = overview(); partialCache.conversation.cacheStatus = 'partial'; partialCache.conversation.cachedInputTokens = 0;
    assert.match(usageOverviewLines(partialCache)[0], /缓存率 数据不完整/);
    const oldCore = overview(); delete oldCore.conversation.cacheStatus; oldCore.conversation.cachedInputTokens = 0;
    assert.match(usageOverviewLines(oldCore)[0], /缓存率 未提供/);
    const unavailableCache = overview(); unavailableCache.conversation.cacheStatus = 'unknown'; unavailableCache.conversation.cachedInputTokens = 0;
    assert.match(usageOverviewLines(unavailableCache)[0], /缓存率 未提供/);
    const precise = overview();
    precise.account.source = null;
    precise.account.balances = [{ currency: 'CNY', available: '12345678901234567890.000000000001', totalUsed: '0.000000000003' }];
    const line = usageOverviewLines(precise)[2];
    assert.match(line, /12345678901234567890\.000000000001/); assert.match(line, /0\.000000000003/); assert.match(line, /来源 未提供/);
});

test('approval choice retains action and paths first, with internal identities only in explicit details', async () => {
    const { ui } = fixture(async () => ({ ok: true, data: { items: [{ interactionId: 'fixture-question', conversationId: 'fixture-conversation', runId: 'fixture-run', policyRevision: 2, toolName: 'write_file',
        scope: { paths: ['README.md'], effects: ['更新文件'], reason: '保存说明' }, expiresAt: 'later' }] } }));
    try {
        ui.conversation = { conversationId: 'fixture-conversation' };
        await ui.approvalsMenu(); await ui.menu.items[0].action();
        assert.ok(ui.menu.context.some(line => /README\.md/.test(line)));
        assert.doesNotMatch(ui.menu.context.slice(0, 3).join(''), /fixture-question|fixture-conversation|fixture-run/);
        assert.equal(ui.menu.items[0].label, '拒绝本动作');
        assert.ok(ui.view().details.some(line => /README\.md/.test(line)) || ui.view().details.some(line => /PgUp\/PgDn/.test(line)));
    } finally { await ui.finish(0); }
});

test('footer keeps all three live usage rows in an inline fixed input frame', () => {
    const renderer = new TerminalRenderer({ color: false, graphics: 'none', reducedMotion: true });
    try {
        const text = terminalSafeText(renderer.render({ inline: true, state: 'idle', status: '就绪', connection: '已连接', details: [], logs: [],
            metrics: usageOverviewLines(overview()), draft: new DraftBuffer(), hint: '@材料 /命令', stateStartedAt: Date.now() }, 120, 35));
        assert.match(text, /本对话 120 token/); assert.match(text, /对话费用/); assert.match(text, /API已用/); assert.match(text, /@材料/);
    } finally { renderer.dispose(); }
});

test('restored messages show public text and media descriptions while leaving native private fields in details', () => {
    const text = historyMessage({ role: 'assistant', value: { response: { complete: false, blocks: [
        { type: 'text', text: '可以接着聊' }, { type: 'text', text: 'hidden-thought-fixture', thought: true },
        { type: 'image', mime: 'image/png', dataBase64: 'fixture-binary' },
    ] } } });
    assert.match(text, /可以接着聊.*\n.*image\/png/s); assert.match(text, /未完整/);
    assert.doesNotMatch(text, /hidden-thought-fixture|fixture-binary/);
});

test('first use, first answer, exit and fresh UI reopening retain model, roots and readable history', async () => {
    let saved;
    const { ui, client, output, calls } = fixture(async (method, params) => {
        if (method === 'conversations.create') {
            saved = { conversationId: 'fixture-saved-conversation', options: structuredClone(params.options), retention: params.retention,
                revision: 1, historyEpoch: 0, appendSeq: 0, state: 'open' };
            return { ok: true, receiptId: 'fixture-create-receipt', data: saved };
        }
        if (method === 'conversations.get') return { ok: true, data: structuredClone(saved), eventCursor: 'fixture-cursor' };
        if (method === 'runs.startInteractive') {
            saved.appendSeq = 2;
            return { ok: true, receiptId: 'fixture-start-receipt', data: { runId: 'fixture-first-run', state: 'succeeded', cleanupState: 'released', resultContentId: 'fixture-answer-content' } };
        }
        if (method === 'conversations.close') { saved.state = 'closed'; return { ok: true, receiptId: 'fixture-close-receipt', data: saved }; }
        if (method === 'conversations.reopen') { saved.state = 'open'; return { ok: true, receiptId: 'fixture-reopen-receipt', data: saved }; }
        if (method === 'conversations.readHistory') return { ok: true, data: { items: [
            { role: 'user', value: { text: '第一条消息' } }, { role: 'assistant', value: { response: { complete: true, blocks: [{ type: 'text', text: '第一条答复' }] } } },
        ], hasMore: false, nextCursor: null } };
        return { ok: true, data: {} };
    });
    const configureMonitoring = instance => {
        instance.eventCursor = new AppliedEventCursor();
        instance.getControlLease = () => undefined;
        instance.claimControl = async () => ({ ok: true, data: {} });
        instance.releaseControl = async () => ({ ok: true });
        instance.subscribeEvents = async () => ({ ok: true, data: { subscriptionId: 'fixture-subscription' } });
        instance.unsubscribeEvents = async () => ({ ok: true });
        instance.readEvents = async () => ({ ok: true, data: { events: [], nextCursor: 'fixture-cursor', hasMore: false } });
        instance.ackEvents = async () => ({ ok: true });
    };
    configureMonitoring(client);
    client.readArtifact = async () => {
        const bytes = Buffer.from(JSON.stringify({ text: '第一条答复' }));
        return { ok: true, data: { bytes, mime: 'application/json', totalBytes: bytes.length, sha256: 'fixture-verified-by-client' } };
    };
    let reopened;
    try {
        ui.creation = { mode: 'archive', title: '', roots: [process.cwd()] };
        ui.newSelection = { profileId: 'cli-fixture-provider', modelId: 'fixture-model' };
        ui.draft.replace('第一条消息'); await ui.createSelectedConversation();
        assert.equal(ui.selectedModel, 'fixture-model'); assert.equal(ui.draft.text, '第一条消息');
        await ui.sendDraft(); await ui.loadRunOutput();
        await ui.quit(false); assert.equal(saved.state, 'closed');
        reopened = new InteractiveCli({ words: [], options: { plain: true } }, client,
            { stdin: Readable.from([]), stdout: ui.streams.stdout, stderr: ui.streams.stderr, cwd: process.cwd() });
        await reopened.openConversation(saved.conversationId);
        assert.equal(saved.state, 'open'); assert.equal(reopened.selectedProfile, 'cli-fixture-provider');
        assert.equal(reopened.selectedModel, 'fixture-model'); assert.deepEqual(reopened.conversation.options.writeRoots, [process.cwd()]);
        assert.match(output.join(''), /你：第一条消息/); assert.match(output.join(''), /助手：第一条答复/);
        assert.equal(calls.filter(call => call.method === 'runs.startInteractive').length, 1);
        assert.equal(calls.some(call => call.method === 'runs.start'), false);
    } finally { await ui.finish(0); await reopened?.finish(0); }
});

test('system folder picker uses an STA hidden host, reads Unicode, and returns cancellation without a path', async () => {
    for (const selected of ['C:\\fixture\\中文项目', '']) {
        let captured;
        const spawnProcess = (executable, args, options) => {
            captured = { executable, args, options };
            const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill() {} });
            queueMicrotask(() => { child.stdout.end(selected); child.emit('close', 0); });
            return child;
        };
        const result = await pickDirectory('C:\\fixture\\原目录', { platform: 'win32', spawnProcess });
        assert.equal(result, selected || undefined);
        assert.ok(captured.args.includes('-STA')); assert.equal(captured.options.windowsHide, true);
        assert.equal(captured.options.shell, false); assert.equal(captured.options.env.SANDBOX_AGENT_PICKER_PATH, 'C:\\fixture\\原目录');
        assert.ok(captured.args.at(-1).includes('FolderBrowserDialog'));
    }
});

test('cancelling the system picker returns to the directory page without changing draft or write roots', async () => {
    const { ui } = fixture(async () => ({ ok: true, data: {} }));
    try {
        const roots = [process.cwd()]; let selected = false;
        ui.conversation = { conversationId: 'fixture-conversation', options: { writeRoots: roots } };
        ui.draft.replace('未发送的草稿'); ui.folderPicker = async () => undefined;
        await ui.browseDirectory(process.cwd(), async () => { selected = true; });
        const item = ui.menu.items.find(entry => /系统文件夹/.test(entry.label));
        ui.menu = undefined; await item.action();
        assert.match(ui.menu.title, /选择文件夹/); assert.equal(selected, false);
        assert.equal(ui.draft.text, '未发送的草稿'); assert.deepEqual(ui.conversation.options.writeRoots, roots);
    } finally { await ui.finish(0); }
});

test('classic block fallback changes idle character cells within the original fixed area', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'blocks', reducedMotion: false });
    const now = Date.now;
    try {
        let clock = 0; Date.now = () => clock;
        const view = { inline: true, state: 'idle', status: '空闲', connection: '已连接', details: ['菜单保持打开'], logs: [],
            metrics: usageOverviewLines(overview()), draft: new DraftBuffer(), hint: '@材料 /命令', stateStartedAt: 0 };
        renderer.render(view, 100, 32);
        clock = 1400; const changed = renderer.render(view, 100, 32);
        assert.match(changed, /48;2;/);
        const positions = [...changed.matchAll(/\x1b\[(\d+);1H/g)].map(match => Number(match[1]));
        assert.ok(positions.some(row => row >= 14 && row <= 22));
        assert.ok(positions.every(row => row >= 11 && row <= 32));
        assert.doesNotMatch(changed, /\r|\n/);
        clock = 2300; assert.notEqual(renderer.render(view, 100, 32), changed);
    } finally { Date.now = now; renderer.dispose(); }
});

test('an open idle menu keeps the UI animation scheduler running', async () => {
    const { ui } = fixture(async () => ({ ok: true, data: {} }));
    try {
        let frames = 0; ui.motionMode = 'full';
        ui.menu = { title: '空闲菜单', index: 0, items: [{ label: '返回', action() {} }] };
        ui.renderer.assets.nextFrameDelay = () => 15;
        ui.scheduleRender = () => { frames += 1; };
        ui.animate(); await new Promise(resolveWait => setTimeout(resolveWait, 65));
        assert.ok(frames >= 2);
    } finally { await ui.finish(0); }
});
