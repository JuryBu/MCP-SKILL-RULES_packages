import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { runFailureLines } from '../../../src/agent-cli/run-view.ts';
import { interactiveResultLines } from '../../../src/agent-cli/ui-results.ts';

function failedRun(acceptance = 'not_sent') {
    return { runId: 'fixture-failed-run', runEpoch: 1, state: 'failed', cleanupState: 'not_needed', failure: {
        acceptance, error: { code: 'STORAGE_UNAVAILABLE', message: '预算账本写入失败：mode约束尚未支持当前计量方式', mayHaveStarted: false },
        cleanupEvidence: 'no_resources_created', actionId: null, attemptId: null,
    } };
}

function fixture() {
    const stdout = [], screen = [], calls = [];
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd(), request: async (method, params) => {
        calls.push({ method, params }); return { ok: true, data: failedRun() };
    } });
    const streams = { stdin: Readable.from([]), stdout: new Writable({ write(bytes, _encoding, done) { stdout.push(bytes.toString()); done(); } }),
        stderr: new Writable({ write(bytes, _encoding, done) { screen.push(bytes.toString()); done(); } }), cwd: process.cwd() };
    const ui = new InteractiveCli({ words: [], options: { plain: true } }, client, streams);
    ui.conversation = { conversationId: 'fixture-conversation', historyEpoch: 0 };
    return { ui, streams, stdout, screen, calls };
}

test('normal failure presentation shows the message and explicit transmission facts, without internal identifiers', () => {
    const lines = runFailureLines(failedRun());
    assert.match(lines[0], /预算账本写入失败/); assert.match(lines[1], /明确未发送到供应商/);
    assert.doesNotMatch(lines.join('\n'), /STORAGE_UNAVAILABLE|fixture-failed-run/);
    assert.doesNotMatch(lines.join('\n'), /可重试|自动重试/);
    assert.match(lines.join('\n'), /未自动重新发送/);
});

test('accepted, rejected and unknown acceptance preserve the actual distinction', () => {
    assert.match(runFailureLines(failedRun('accepted'))[1], /供应商已受理.*保留原回执/);
    assert.match(runFailureLines(failedRun('rejected'))[1], /供应商已拒绝/);
    assert.match(runFailureLines(failedRun('unknown'))[1], /结果待核实.*保留原回执/);
    assert.match(runFailureLines(failedRun(null))[1], /结果待核实/);
});

test('failure snapshot immediately supplies readable details while preserving the later draft and sending nothing', async () => {
    const { ui, calls } = fixture();
    try {
        ui.draft.replace('后来补充、尚未发送的草稿'); ui.run = failedRun(); ui.updateState();
        assert.match(ui.view().details.join('\n'), /预算账本写入失败[\s\S]*明确未发送/);
        assert.equal(ui.draft.text, '后来补充、尚未发送的草稿'); assert.equal(calls.length, 0);
        const count = ui.logs.length; ui.updateState(); assert.equal(ui.logs.length, count);
    } finally { await ui.finish(0); }
});

test('ordinary status is readable while explicit JSON keeps technical codes and full run identity', async () => {
    const run = failedRun();
    const normal = interactiveResultLines({ method: 'runs.get', result: { ok: true, data: run } });
    assert.match(normal.join('\n'), /明确未发送/); assert.doesNotMatch(normal.join('\n'), /STORAGE_UNAVAILABLE/);
    const raw = interactiveResultLines({ method: 'runs.get', result: { ok: true, data: run } }, { raw: true });
    assert.deepEqual(JSON.parse(raw.join('\n')), run);
    const { ui, calls } = fixture();
    try {
        ui.run = run; await ui.executeLine('/status --json');
        assert.equal(calls.length, 1); assert.equal(calls[0].method, 'runs.get');
        assert.match(ui.details.join('\n'), /STORAGE_UNAVAILABLE.*|fixture-failed-run/);
    } finally { await ui.finish(0); }
});

test('interactive transcript keeps one visible chat copy and clears the old directory page when stdout is redirected', async () => {
    for (const stdoutTty of [false, true]) {
        const { ui, streams, stdout, screen } = fixture();
        try {
            ui.terminal.linear = false; streams.stdout.isTTY = stdoutTty; streams.stderr.isTTY = true;
            ui.details = ['选择文件夹', '旧目录页面'];
            ui.renderer.render(ui.view(), 91, 29);
            await ui.printTranscript('你：只出现一次的用户输入');
            assert.equal(stdout.join(''), '');
            assert.equal(screen.join(''), '');
            assert.equal(ui.renderer.render(ui.view(), 91, 29).split('只出现一次的用户输入').length - 1, 1);
            assert.equal(ui.view().details.join('\n').split('只出现一次的用户输入').length - 1, 1);
            assert.doesNotMatch(ui.view().details.join('\n'), /旧目录页面/);
        } finally { await ui.finish(0); }
    }
});
