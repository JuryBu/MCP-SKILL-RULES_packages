import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { chatUsageLines, declaredParameterFields, detailedUsageLines, groupProviderProfiles, idleAppearance, optionalDateTime, readParameterValues } from '../../../src/agent-cli/ui-workflow.ts';

const firstProfile = { profileId: 'fixture-key-a', label: '日常使用', baseUrl: 'https://api.deepseek.com', protocol: 'compatible_chat', credentialRef: 'fixture-credential', revision: 1,
    defaultModel: 'fixture-main', compressionModelRef: null, routePolicy: { version: 'fixture-route', allowedModels: ['fixture-main', 'fixture-compact'] } };
const secondProfile = { ...firstProfile, profileId: 'fixture-key-b', label: '课程项目' };
const entry = { modelId: 'fixture-main', tools: { status: 'supported', value: true,
    observedAt: new Date(Date.now() - 60000).toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() }, parameters: {
    reasoningEffort: { status: 'supported', value: { type: 'string', enum: ['low', 'high'] } },
    temperature: { status: 'supported', value: { type: 'number', min: 0, max: 2 } },
    maxOutputTokens: { status: 'supported', value: { type: 'integer', min: 1, max: 8192 } },
    unsupported: { status: 'unknown', value: { type: 'number' } },
} };

function fixture(extra) {
    const calls = [];
    const output = [];
    const conversations = new Map();
    const attachments = new Map();
    const client = Object.assign(new EventEmitter(), {
        dataDir: process.cwd(),
        request: async (method, params = {}, options) => {
            calls.push({ method, params: structuredClone(params), options });
            const custom = await extra?.(method, params, options);
            if (custom) return custom;
            if (method === 'profiles.list') return { ok: true, data: { items: [firstProfile, secondProfile] } };
            if (method === 'profiles.get') return { ok: true, data: params.profileId === secondProfile.profileId ? secondProfile : firstProfile };
            if (method === 'models.list') return { ok: true, data: { entries: [{ modelId: 'fixture-main', displayName: '主模型' }, { modelId: 'fixture-compact', displayName: '压缩模型' }] } };
            if (method === 'models.get') return { ok: true, data: { entry } };
            if (method === 'usage.overview') return { ok: true, data: usage() };
            if (method === 'conversations.prepareTemporaryCreate') return { ok: true, data: { clientCommandId: 'fixture-temporary-create' } };
            if (method === 'conversations.create') {
                const conversation = { conversationId: 'fixture-created', revision: 1, options: params.options, retention: params.retention };
                conversations.set(conversation.conversationId, conversation);
                return { ok: true, receiptId: 'fixture-create-receipt', data: conversation };
            }
            if (method === 'conversations.references.prepare') {
                if (attachments.has(params.source)) return { ok: true, data: { reference: structuredClone(attachments.get(params.source)) } };
                const sha256 = createHash('sha256').update(params.source).digest('hex');
                const reference = { kind: 'file', source: params.source, referenceId: 'attachment:' + sha256, sha256, prepareState: 'ready' };
                attachments.set(reference.referenceId, reference);
                return { ok: true, data: { reference } };
            }
            if (method === 'runs.startInteractive') return { ok: true, receiptId: 'fixture-send-receipt', data: { runId: 'fixture-run', state: 'succeeded', cleanupState: 'not_needed' } };
            if (method === 'conversations.close') return { ok: true, receiptId: 'fixture-close-receipt', data: {} };
            return { ok: true, data: {} };
        },
        releaseControl: async (scope, id) => { calls.push({ method: 'releaseControl', scope, id }); return { ok: true }; },
        getControlLease: () => undefined,
    });
    const stream = new Writable({ write(bytes, _encoding, done) { output.push(bytes.toString()); done(); } });
    stream.columns = 120; stream.rows = 34;
    const ui = new InteractiveCli({ words: [], options: { graphics: 'none', color: 'never', 'reduce-motion': true } }, client,
        { stdin: Readable.from([]), stdout: stream, stderr: stream, cwd: process.cwd() });
    ui.openConversation = async id => { ui.conversation = conversations.get(id); ui.restoreSelection(ui.conversation); };
    return { ui, client, calls, output, conversations };
}

function usage() {
    return { asOf: '2026-11-13T00:00:00Z', account: { status: 'unsupported', source: null, balances: [] },
        conversation: { totalTokens: 8793, inputTokens: 8087, outputTokens: 706, cachedInputTokens: 0, cacheStatus: 'known', tokensStatus: 'known', costs: [], amountStatus: 'unknown' },
        providerUsage: { scope: 'local_tool', costs: [], amountStatus: 'unknown' } };
}

async function choose(ui, label) {
    const index = ui.menu?.items.findIndex(item => item.label === label || item.label.startsWith(label));
    assert.ok(index >= 0, `menu ${ui.menu?.title} misses ${label}`);
    ui.menu.index = index;
    await ui.handleKey({ name: 'enter' });
}

function openFixtureConversation(ui, mode = 'archive') {
    ui.conversation = { conversationId: 'fixture-current', revision: 1, historyEpoch: 1, retention: { mode }, options: { projectName: '课程项目', writeRoots: [process.cwd()], profileId: firstProfile.profileId, modelId: 'fixture-main' } };
    ui.restoreSelection(ui.conversation);
}

test('cwd project -> temporary -> provider -> key -> main/compression -> chat uses conversation-local choices', async () => {
    const { ui, calls } = fixture();
    try {
        ui.draft.replace('请读表格并写中文结果');
        ui.draft.references = [{ kind: 'file', path: 'fixture.csv' }];
        ui.showStartup();
        assert.match(ui.menu.title, /项目与对话/);
        await choose(ui, '新建对话');
        await choose(ui, '临时对话');
        assert.equal(ui.creation.mode, 'temporary');
        await choose(ui, 'DeepSeek');
        assert.equal(ui.menu.items.filter(item => ['日常使用', '课程项目'].includes(item.label)).length, 2);
        await choose(ui, '课程项目');
        await choose(ui, '主模型');
        assert.equal(ui.menu.title, '确认后开始聊天');
        await choose(ui, '压缩模型');
        await choose(ui, '从这个Key可用的模型中选择');
        await choose(ui, '压缩模型');
        assert.deepEqual(ui.creation.compression, { profileId: secondProfile.profileId, modelId: 'fixture-compact' });
        assert.equal(calls.some(call => call.method === 'profiles.put'), false);
        await choose(ui, '开始聊天');
        const create = calls.find(call => call.method === 'conversations.create');
        assert.ok(create, JSON.stringify({ logs: ui.logs, details: ui.details, calls: calls.map(call => call.method) }));
        assert.equal(create.params.retention.mode, 'temporary');
        assert.equal(create.params.callerHost, 'standalone-cli');
        assert.equal(create.params.options.modelId, 'fixture-main');
        assert.equal(create.params.options.compressionModelSelection.modelId, 'fixture-compact');
        assert.equal(ui.draft.text, '请读表格并写中文结果');
        assert.deepEqual(ui.draft.references, [{ kind: 'file', path: 'fixture.csv' }]);
        assert.equal(ui.creation, undefined);
    } finally { await ui.finish(0); }
});

test('escape goes to the preceding wizard step and preserves temporary intent and draft', async () => {
    const { ui } = fixture();
    try {
        ui.draft.replace('未发送的中文草稿');
        await ui.newConversation('temporary');
        await choose(ui, 'DeepSeek');
        await ui.handleKey({ name: 'escape' });
        assert.equal(ui.menu.title, '选择API服务商');
        assert.equal(ui.creation.mode, 'temporary');
        await ui.handleKey({ name: 'escape' });
        assert.equal(ui.menu.title, '新对话 · 保存方式');
        assert.equal(ui.draft.text, '未发送的中文草稿');
    } finally { await ui.finish(0); }
});

test('declared parameter controls expose fresh supported enums, booleans and bounded numbers', () => {
    const source = { parameters: { ...entry.parameters, enabled: { status: 'supported', value: { type: 'boolean' } }, expired: { status: 'supported', expiresAt: '2020-01-01T00:00:00Z', value: { type: 'integer' } } } };
    const fields = declaredParameterFields(source, {});
    assert.deepEqual(fields.find(field => field.key === 'reasoningEffort').choices, ['', 'low', 'high']);
    assert.deepEqual(fields.find(field => field.key === 'enabled').choices, ['', 'true', 'false']);
    assert.ok(fields.find(field => field.key === 'temperature').validate('3'));
    assert.ok(fields.find(field => field.key === 'maxOutputTokens').validate('1.5'));
    assert.equal(fields.some(field => ['expired', 'unsupported'].includes(field.key)), false);
    assert.deepEqual(readParameterValues(source, { temperature: '0.6', maxOutputTokens: '4096', enabled: 'false', reasoningEffort: 'high' }, {}),
        { temperature: 0.6, maxOutputTokens: 4096, enabled: false, reasoningEffort: 'high' });
});

test('returning an archive preserves the actual draft and references without closing the app or conversation', async () => {
    const { ui, calls } = fixture();
    try {
        openFixtureConversation(ui);
        ui.draft.replace('回来继续的草稿'); ui.draft.references = [{ kind: 'file', path: 'original.csv' }];
        const draft = ui.draft;
        assert.equal(await ui.leaveCurrentConversation('return', true), true);
        assert.equal(ui.disposed, false);
        assert.equal(ui.conversation, undefined);
        assert.equal(ui.drafts.get('fixture-current'), draft);
        assert.deepEqual(draft.references, [{ kind: 'file', path: 'original.csv' }]);
        assert.equal(calls.some(call => call.method === 'conversations.close'), false);
        assert.match(ui.menu.title, /课程项目/);
    } finally { await ui.finish(0); }
});

test('closing a temporary conversation removes its input history and stays in the application', async () => {
    const { ui, calls } = fixture();
    try {
        openFixtureConversation(ui, 'temporary');
        ui.history.push({ text: '临时正文', references: [{ kind: 'file', path: 'private.csv' }], conversationId: 'fixture-current' });
        assert.equal(await ui.leaveCurrentConversation('close', true), true);
        assert.equal(ui.disposed, false);
        assert.equal(ui.history.length, 0);
        assert.equal(ui.draft.references.length, 0);
        assert.equal(calls.filter(call => call.method === 'conversations.close').length, 1);
    } finally { await ui.finish(0); }
});

test('D04 history consumes the selected original draft and references in both the view and real submission preparation', async () => {
    const { ui, calls } = fixture();
    try {
        openFixtureConversation(ui);
        ui.draft.replace('第一份输入\n请统计这份CSV');
        ui.draft.references = [{ kind: 'file', path: 'selected.csv' }];
        await ui.sendDraft();
        ui.draft.replace('第二份输入'); ui.draft.references = [{ kind: 'file', path: 'latest.csv' }];
        await ui.sendDraft();
        ui.showInputHistory();
        ui.menu.index = 1;
        await ui.handleKey({ name: 'enter' });
        const view = ui.view();
        assert.equal(view.draft.text, '第一份输入\n请统计这份CSV');
        const originalSubmission = calls.find(call => call.method === 'runs.startInteractive');
        assert.deepEqual(view.draft.references, originalSubmission.params.input.references);
        assert.match(view.inputLabel, /1 份材料/);
        assert.match(view.details.join('\n'), /selected.csv/);
        await ui.sendDraft();
        const sends = calls.filter(call => call.method === 'runs.startInteractive');
        assert.equal(sends.length, 3);
        assert.equal(sends[2].params.input.text, '第一份输入\n请统计这份CSV');
        assert.ok(sends[2].params.input.references[0].source.endsWith('selected.csv'));
        assert.equal(sends[2].params.input.references.some(reference => reference.source.endsWith('latest.csv')), false);
    } finally { await ui.finish(0); }
});

test('true zero cache is visible; unknown cost and partial token denominators do not produce invented totals', () => {
    assert.match(chatUsageLines(usage()).join('\n'), /8793 token.*0.0%/);
    assert.doesNotMatch(chatUsageLines(usage()).join('\n'), /金额未提供|费用.*0/);
    const partial = usage(); partial.conversation.tokensStatus = 'partial';
    assert.doesNotMatch(chatUsageLines(partial).join('\n'), /%/);
});

test('provider grouping presents multiple key purposes together and strips credential-bearing URL fragments', () => {
    const groups = groupProviderProfiles([{ ...firstProfile, baseUrl: 'https://user:password@api.deepseek.com/?key=secret#fragment' }, secondProfile]);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].label, 'DeepSeek');
    assert.equal(groups[0].profiles.length, 2);
    assert.doesNotMatch(groups[0].baseUrl, /password|secret|key=/);
});

test('idle appearance waits 30 seconds from the later actual input or reply end; running work stays human', () => {
    assert.equal(idleAppearance(1000, 4000, 33_999).appearance, 'human');
    assert.deepEqual(idleAppearance(1000, 4000, 34_000), { appearance: 'cat', appearanceStartedAt: 34_000 });
    assert.equal(idleAppearance(35_000, 4000, 35_000).appearance, 'human');
    assert.equal(idleAppearance(1000, 4000, 100_000, true).appearance, 'human');
});

test('real key handling immediately restores human appearance without relying on backend refresh or an animation tick', async () => {
    const { ui } = fixture();
    try {
        ui.lastUserActivityAt = Date.now() - 40_000; ui.lastReplyFinishedAt = 0;
        assert.equal(ui.view().appearance, 'cat');
        await ui.handleKey({ name: 'text', text: '继续' });
        assert.equal(ui.view().appearance, 'human');
        assert.equal(ui.draft.text, '继续');
    } finally { await ui.finish(0); }
});

test('normal completion hides empty phase and normal cleanup details while preserving abnormal cleanup', async () => {
    const { ui } = fixture();
    try {
        ui.run = { runId: 'fixture-complete', state: 'succeeded', cleanupState: 'not_needed' };
        ui.updateState();
        assert.equal(ui.status, '回复完成');
        ui.run.cleanupState = 'unconfirmed'; ui.updateState();
        assert.match(ui.status, /资源收尾待核实/);
    } finally { await ui.finish(0); }
});

test('an unknown new-conversation result is recovered by the original command even after preparation changes', async () => {
    const { ui, client, calls } = fixture(async method => method === 'conversations.create'
        ? { ok: false, error: { code: 'RECEIPT_UNKNOWN', mayHaveStarted: true, retryable: true, message: '原新建待确认' } } : undefined);
    try {
        await ui.newConversation('temporary');
        await choose(ui, 'DeepSeek'); await choose(ui, '日常使用'); await choose(ui, '主模型');
        await choose(ui, '开始聊天');
        const create = calls.find(call => call.method === 'conversations.create');
        assert.ok(create);
        ui.creation.title = '改变后的名称';
        let receiptChecks = 0;
        client.getReceipt = async commandId => {
            receiptChecks += 1;
            assert.equal(commandId, create.params.clientCommandId);
            return { ok: true, data: { result: { ok: false, error: { code: 'ORIGINAL_FAILED', message: '原新建失败', mayHaveStarted: false } } } };
        };
        await ui.createSelectedConversation();
        assert.equal(receiptChecks, 1);
        assert.equal(calls.filter(call => call.method === 'conversations.create').length, 1);
        assert.equal(ui.pendingCreationArguments, undefined);
    } finally { await ui.finish(0); }
});

test('an existing conversation compression selection updates only conversation options', async () => {
    const { ui, calls } = fixture(async (method, params) => method === 'conversations.get' ? { ok: true, data: { conversationId: 'fixture-current', revision: 2, options: params.options ?? {} } } : undefined);
    try {
        openFixtureConversation(ui);
        ui.settingsMenu(); await choose(ui, '本对话压缩模型'); await choose(ui, '压缩模型'); await choose(ui, '确认使用');
        const update = calls.find(call => call.method === 'conversations.update');
        assert.equal(update.params.options.compressionModelSelection.modelId, 'fixture-compact');
        assert.equal(calls.some(call => call.method === 'profiles.put'), false);
    } finally { await ui.finish(0); }
});

test('UI formats the complete Markdown cache before slicing and keeps fenced content and source exact', async () => {
    const { ui } = fixture();
    try {
        const source = ['# 中文结果', '**完成统计**', '```text', ...Array.from({ length: 30 }, (_, index) => '**原件' + index + '**'), '```', '[查看来源](https://example.test/source)'];
        ui.transcript = [...source]; ui.details = []; ui.transcriptFollow = false;
        const lines = ui.detailLines();
        assert.equal(lines[0], '中文结果');
        assert.equal(lines[1], '完成统计');
        assert.ok(lines.includes('**原件20**'));
        assert.deepEqual(ui.transcript, source);
        ui.scrollDetails(3);
        assert.equal(ui.detailsOffset, 3);
        assert.match(ui.view().hint, /PgUp\/PgDn回看/);
    } finally { await ui.finish(0); }
});

test('UI native viewport events update both surfaces and preserve real wheel distance', async () => {
    const { ui } = fixture();
    try {
        let onEvent;
        ui.streams.stdin.isTTY = true; ui.streams.stderr.isTTY = true;
        ui.createNativeGraphics = listener => { onEvent = listener; return { start() {}, hide() {}, close() {} }; };
        ui.startNativeGraphics();
        assert.equal(typeof onEvent, 'function');
        ui.transcript = Array.from({ length: 80 }, (_, index) => '原文第' + index + '行'); ui.transcriptFollow = false; ui.detailsOffset = 10;
        onEvent({ type: 'viewport', viewport: { top: 10, left: 0, columns: 120, rows: 34, bufferColumns: 120, bufferRows: 200 } });
        const before = ui.terminal.frameGeometry();
        onEvent({ type: 'viewport', scrollRows: -3, viewport: { top: 7, left: 0, columns: 120, rows: 34, bufferColumns: 120, bufferRows: 200 } });
        assert.equal(ui.detailsOffset, 7);
        assert.equal(ui.terminal.isCurrentGeometry(before), false);
        assert.equal(ui.nativePaintRevision, -1);
    } finally { await ui.finish(0); }
});

test('UI native frame boundaries use content changes rather than the always-present caret output', async () => {
    const { ui } = fixture();
    const commands = [];
    try {
        ui.renderer.options.graphics = 'native'; ui.renderer.options.color = true;
        ui.nativeGraphicsReady = true;
        ui.nativeGraphics = { beginFrame() { commands.push('begin'); }, frame() { commands.push('frame'); return true; }, endFrame() { commands.push('end'); }, hide() {}, close() {} };
        ui.scheduleRender(true);
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.ok(commands.includes('frame'));
        assert.equal(commands.filter(value => value === 'begin').length, 1);
        assert.equal(commands.filter(value => value === 'end').length, 1);
        ui.scheduleRender(true);
        await new Promise(resolve => setTimeout(resolve, 35));
        assert.equal(ui.renderer.lastRenderChanged, false);
        assert.equal(commands.filter(value => value === 'begin').length, 1);
        assert.equal(commands.filter(value => value === 'end').length, 1);
    } finally { await ui.finish(0); }
});

test('unknown close uses its original receipt and never repeats the close before returning', async () => {
    const { ui, client, calls } = fixture(async method => method === 'conversations.close' ? { ok: false, error: { code: 'RECEIPT_UNKNOWN', mayHaveStarted: true, message: '关闭结果待确认' } } : undefined);
    try {
        openFixtureConversation(ui, 'temporary');
        assert.equal(await ui.leaveCurrentConversation('close', true), false);
        const close = calls.find(call => call.method === 'conversations.close');
        client.getReceipt = async commandId => {
            assert.equal(commandId, close.options.clientCommandId);
            return { ok: true, data: { result: { ok: true, receiptId: 'fixture-close-confirmed', data: {} } } };
        };
        assert.equal(await ui.leaveCurrentConversation('close', true), true);
        assert.equal(calls.filter(call => call.method === 'conversations.close').length, 1);
        assert.equal(ui.disposed, false);
    } finally { await ui.finish(0); }
});

test('normal view keeps receipts and unrelated server-lease events in explicit details', async () => {
    const { ui } = fixture();
    try {
        ui.showResult({ method: 'profiles.put', result: { ok: true, receiptId: 'fixture-operation-uuid', data: { label: '日常Key' } } });
        ui.lostControl({ message: '原服务器租约fixture-internal-lease已释放', lease: { scope: 'server' } });
        const view = ui.view();
        assert.equal(view.logs.length, 0);
        assert.doesNotMatch(view.connection + view.status, /fixture-operation-uuid|租约|待申请/);
        await ui.executeLine('/status');
        await choose(ui, '最近操作的原始回执');
        assert.match(ui.details.join('\n'), /fixture-operation-uuid/);
        await ui.executeLine('/status --diagnostics');
        assert.match(ui.details.join('\n'), /fixture-internal-lease/);
    } finally { await ui.finish(0); }
});

test('optional information saves source, purpose, notes and human-recorded time without touching credentials', async () => {
    const { ui, calls } = fixture();
    try {
        ui.profileInformationForm(firstProfile);
        for (const text of ['官方账号申请', '课程CSV统计', '保留中文备注\n继续核查', '2026-11-13T12:00:00+08:00']) { ui.form.draft.replace(text); await ui.handleKey({ name: 'enter' }); }
        const write = calls.find(call => call.method === 'profiles.put');
        assert.ok(write, ui.logs.join('\n'));
        assert.equal(write.params.profile.information.purpose, '课程CSV统计');
        assert.equal(write.params.profile.information.lastTestedAt, '2026-11-13T04:00:00.000Z');
        assert.equal(write.params.profile.credentialRef, firstProfile.credentialRef);
        assert.equal(write.params.profile.dispatchPolicy, undefined);
    } finally { await ui.finish(0); }
});

test('optional stop policy leaves both date and cost unset when blank and never supplies a default ceiling', async () => {
    const { ui, calls } = fixture();
    try {
        ui.profileDispatchPolicyForm(firstProfile);
        for (const text of ['启用', '', '', 'USD']) { ui.form.draft.replace(text); await ui.handleKey({ name: 'enter' }); }
        const write = calls.find(call => call.method === 'profiles.put');
        assert.ok(write, ui.logs.join('\n'));
        assert.deepEqual(write.params.profile.dispatchPolicy, { enabled: true, expiresAt: null });
        assert.equal(write.params.profile.dispatchPolicy.maxCumulativeCost, undefined);
        assert.equal(optionalDateTime(''), null);
        assert.throws(() => optionalDateTime('2026-02-30 18:00'));
    } finally { await ui.finish(0); }
});

test('compression parameter form saves typed per-conversation values and the actual output-limit selection field', async () => {
    const { ui } = fixture();
    try {
        await ui.newConversation('temporary'); await choose(ui, 'DeepSeek'); await choose(ui, '日常使用'); await choose(ui, '主模型');
        await ui.parameterForm('compression');
        for (const text of ['high', '0.4', '4096']) { ui.form.draft.replace(text); await ui.handleKey({ name: 'enter' }); }
        assert.equal(ui.creation.compression.maxOutputTokens, 4096);
        assert.deepEqual(ui.creation.compression.parameters, { reasoningEffort: 'high', temperature: 0.4, maxOutputTokens: 4096 });
        assert.deepEqual(ui.creation.parameters, {});
    } finally { await ui.finish(0); }
});

test('catalog freshness refresh is bounded to one attempt per profile, including a future-dated result', async () => {
    const { ui, calls } = fixture(async method => method === 'models.list' ? { ok: true, data: { catalogVersion: 'future-version', catalog: { freshness: 'future' }, entries: [{ modelId: 'fixture-main' }] } } : undefined);
    try {
        await ui.listModels(firstProfile.profileId);
        assert.equal(calls.filter(call => call.method === 'models.refresh').length, 1);
        assert.match(ui.menu.context.join('\n'), /时间超前/);
    } finally { await ui.finish(0); }
});

test('available cache, current fee and account balance remain on the ordinary view; balance breakdown keeps observation time', async () => {
    const { ui } = fixture();
    try {
        openFixtureConversation(ui);
        const overview = usage();
        overview.conversation.costs = [{ currency: 'CNY', amountMicros: 4000 }]; overview.conversation.amountStatus = 'known';
        overview.account = { status: 'reported', source: 'https://api.deepseek.com/user/balance', observedAt: '2026-11-13T04:00:00Z', balances: [{ currency: 'CNY', available: '18', granted: '2', toppedUp: '16' }] };
        ui.usageOverview = overview;
        const metrics = ui.view().metrics.join('\n');
        assert.match(metrics, /0.0%/); assert.match(metrics, /0.004/); assert.match(metrics, /账号余额 CNY 18/);
        const details = detailedUsageLines(overview).join('\n');
        assert.match(details, /赠送 2/); assert.match(details, /充值 16/); assert.match(details, /本机时间/);
        assert.equal((details.match(/赠送 2/g) ?? []).length, 1);
        assert.doesNotMatch(details, /额度已消耗/);
    } finally { await ui.finish(0); }
});

test('invalid real parameter input stays visible inside the form while raw internal logs stay hidden', async () => {
    const { ui } = fixture();
    try {
        await ui.newConversation('temporary'); await choose(ui, 'DeepSeek'); await choose(ui, '日常使用'); await choose(ui, '主模型');
        await ui.parameterForm();
        for (const text of ['high', '0.4', '0']) { ui.form.draft.replace(text); await ui.handleKey({ name: 'enter' }); }
        assert.equal(ui.form.index, 2);
        assert.match(ui.view().details.join('\n'), /支持的范围/);
        assert.equal(ui.view().logs.length, 0);
        ui.form.draft.replace('4096'); await ui.handleKey({ name: 'enter' });
        assert.equal(ui.form, undefined);
        assert.equal(ui.creation.parameters.maxOutputTokens, 4096);
    } finally { await ui.finish(0); }
});

test('close returns to the project and only explicit exit disposes the application', async () => {
    const { ui } = fixture();
    try {
        openFixtureConversation(ui);
        await ui.executeLine('/close'); await choose(ui, '关闭当前对话');
        assert.equal(ui.disposed, false);
        assert.equal(ui.conversation, undefined);
        await ui.executeLine('/exit'); await choose(ui, '退出应用');
        assert.equal(ui.disposed, true);
    } finally { await ui.finish(0); }
});

test('unknown tool capability keeps the draft and requires an explicit plain-chat confirmation', async () => {
    const { ui, calls } = fixture(method => method === 'models.get'
        ? { ok: true, data: { entry: { ...entry, tools: { ...entry.tools, status: 'unknown', value: null } } } } : undefined);
    try {
        openFixtureConversation(ui);
        ui.draft.replace('请修改当前文件');
        await ui.sendDraft();
        assert.match(ui.menu.title, /工具能力尚未确认/);
        assert.equal(ui.draft.text, '请修改当前文件');
        assert.equal(calls.some(call => call.method === 'runs.startInteractive'), false);
        await choose(ui, '仅普通聊天');
        assert.match(ui.menu.title, /确认仅使用普通聊天/);
        assert.equal(ui.menu.index, 0);
        assert.equal(calls.some(call => call.method === 'conversations.update'), false);
    } finally { await ui.finish(0); }
});
