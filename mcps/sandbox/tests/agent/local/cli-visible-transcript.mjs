import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { AppliedEventCursor } from '../../../src/agent-client/events.ts';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { appendTranscriptLines, MAX_TRANSCRIPT_CHARACTERS } from '../../../src/agent-cli/history-view.ts';

function artifact(value) {
    const bytes = Buffer.from(JSON.stringify(value));
    return { ok: true, data: { bytes, mime: 'application/json', totalBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') } };
}

function fixture() {
    const calls = [];
    const histories = {
        first: [{ role: 'user', value: { text: '只回复：首用连接正常' } },
            { role: 'assistant', value: { response: { complete: true, blocks: [{ type: 'text', text: '首用连接正常' }] } } }],
        second: [{ role: 'user', value: { text: '另一个会话的问题' } },
            { role: 'assistant', value: { response: { complete: true, blocks: [{ type: 'text', text: '另一个会话的回答' }] } } }],
    };
    const client = Object.assign(new EventEmitter(), {
        dataDir: process.cwd(), eventCursor: new AppliedEventCursor(), getControlLease: () => undefined,
        claimControl: async () => ({ ok: true, data: {} }), releaseControl: async () => ({ ok: true }),
        subscribeEvents: async () => ({ ok: true, data: { subscriptionId: 'visible-transcript-subscription' } }),
        unsubscribeEvents: async () => ({ ok: true }), ackEvents: async () => ({ ok: true }),
        readEvents: async () => ({ ok: true, data: { events: [], nextCursor: 'visible-transcript-cursor', hasMore: false } }),
        readArtifact: async (_conversationId, contentId) => artifact(contentId === 'formal-model'
            ? { response: { complete: true, attemptId: 'visible-attempt', blocks: [{ type: 'text', text: '首用连接正常' }] } }
            : { text: '首用连接正常' }),
        request: async (method, params) => {
            calls.push({ method, params });
            if (method === 'conversations.get') return { ok: true, data: { conversationId: params.conversationId,
                state: 'open', revision: 1, appendSeq: 2, options: { modelId: 'visible-model', writeRoots: [process.cwd()] },
                retention: { mode: 'archive' }, run: null }, eventCursor: 'visible-transcript-cursor' };
            if (method === 'conversations.readHistory') return { ok: true, data: { items: histories[params.conversationId], hasMore: false } };
            return { ok: true, data: {} };
        },
    });
    const output = [];
    const stream = Object.assign(new Writable({ write(bytes, _encoding, done) { output.push(bytes.toString()); done(); } }), { columns: 91, rows: 29 });
    const ui = new InteractiveCli({ words: [], options: { plain: true } }, client,
        { stdin: Readable.from([]), stdout: stream, stderr: stream, cwd: process.cwd() });
    ui.terminal.linear = false;
    ui.renderer.options.graphics = 'native'; ui.renderer.options.color = true;
    ui.scheduleRender = () => {};
    return { ui, calls };
}

test('a completed real-shaped model response remains visible in the normal 91 by 29 chat body', async () => {
    const { ui, calls } = fixture();
    try {
        ui.conversation = { conversationId: 'first', options: {}, retention: { mode: 'archive' } };
        ui.run = { runId: 'visible-run', state: 'running' };
        await ui.printTranscript('你：只回复：首用连接正常');
        await ui.showFormalModel('formal-model', 'visible-run', ui.viewEpoch);
        ui.run = { ...ui.run, state: 'succeeded', cleanupState: 'released', resultContentId: 'final-result' };
        await ui.loadRunOutput(); ui.updateState();
        const view = ui.view();
        assert.match(view.details.join('\n'), /你：只回复：首用连接正常[\s\S]*助手：首用连接正常/);
        assert.doesNotMatch(view.details.join('\n'), /准备工作/);
        assert.equal(ui.transcript.join('\n').split('助手：首用连接正常').length - 1, 1);
        assert.match(ui.renderer.render(view, 91, 29), /助手：首用连接正常/);
        assert.equal(calls.some(call => call.method.startsWith('runs.start')), false);
    } finally { await ui.finish(0); }
});

test('fresh opening and history switching restore the original chat body without resending or mixing conversations', async () => {
    const { ui, calls } = fixture();
    const reopened = fixture();
    try {
        await ui.openConversation('first');
        assert.match(ui.view().details.join('\n'), /助手：首用连接正常/);
        await ui.openConversation('second');
        assert.match(ui.view().details.join('\n'), /另一个会话的回答/);
        assert.doesNotMatch(ui.view().details.join('\n'), /首用连接正常/);
        await ui.openConversation('first');
        await ui.restoreTranscript('first');
        assert.equal(ui.transcript.join('\n').split('助手：首用连接正常').length - 1, 1);
        await reopened.ui.openConversation('first');
        assert.match(reopened.ui.view().details.join('\n'), /助手：首用连接正常/);
        assert.equal([...calls, ...reopened.calls].some(call => call.method.startsWith('runs.start')), false);
    } finally { await ui.finish(0); await reopened.ui.finish(0); }
});

test('reading earlier chat stays in place until PageDown explicitly returns to following new text', async () => {
    const { ui } = fixture();
    try {
        await ui.printTranscript(Array.from({ length: 70 }, (_, index) => `已有原文第${index}行`).join('\n'));
        ui.view();
        await ui.handleKey({ name: 'pageup' });
        const offset = ui.detailsOffset;
        assert.equal(ui.transcriptFollow, false);
        await ui.printTranscript('后到的正式原文');
        ui.view();
        assert.equal(ui.detailsOffset, offset);
        for (let index = 0; index < 10; index += 1) await ui.handleKey({ name: 'pagedown' });
        assert.equal(ui.transcriptFollow, true);
        assert.match(ui.view().details.join('\n'), /后到的正式原文/);
    } finally { await ui.finish(0); }
});

test('a computed but uncommitted frame cannot hide the model body after a transcript write completes', async () => {
    const { ui } = fixture();
    const write = ui.terminal.write;
    try {
        let writes = 0;
        ui.terminal.write = async () => { writes += 1; };
        ui.renderer.render(ui.view(), 91, 29);
        await ui.printTranscript('你：只回复：首用连接正常\n\n助手：首用连接正常');
        assert.equal(writes, 0);
        assert.match(ui.renderer.render(ui.view(), 91, 29), /助手：首用连接正常/);
    } finally { ui.terminal.write = write; await ui.finish(0); }
});

test('retained visible chat is bounded while replacing a history page discards the previous conversation', () => {
    const lines = appendTranscriptLines([], '字'.repeat(MAX_TRANSCRIPT_CHARACTERS + 20));
    assert.ok(lines.join('\n').length <= MAX_TRANSCRIPT_CHARACTERS);
    assert.ok(appendTranscriptLines([], '短行\n'.repeat(3000)).length <= 2000);
    assert.deepEqual(appendTranscriptLines(['旧会话'], '新会话', true), ['新会话']);
});
