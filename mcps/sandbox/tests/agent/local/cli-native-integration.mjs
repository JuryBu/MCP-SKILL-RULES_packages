import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { TerminalRenderer } from '../../../src/agent-cli/renderer.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';
import { graphicsSummary } from '../../../src/agent-cli/ui-results.ts';

function view() { return { inline: true, state: 'thinking', stateStartedAt: Date.now(), status: '正在工作', connection: '已连接',
    details: ['正文保持在图像右侧'], logs: [], draft: new DraftBuffer(), hint: 'Enter发送' }; }

async function flush(ui) {
    for (let attempt = 0; attempt < 60 && (ui.renderTimer || ui.renderInFlight); attempt += 1) await delay(10);
    assert.equal(Boolean(ui.renderTimer || ui.renderInFlight), false);
}

function fixture() {
    const events = [], frames = [];
    let receive;
    const input = Readable.from([]); input.isTTY = true;
    const output = new Writable({ write(_bytes, _encoding, done) { done(); } });
    output.isTTY = true; output.columns = 91; output.rows = 29;
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd() });
    const ui = new InteractiveCli({ words: [], options: { graphics: 'auto', color: 'always' } }, client,
        { stdin: input, stdout: output, stderr: output, cwd: process.cwd() });
    ui.createNativeGraphics = onEvent => {
        receive = onEvent;
        return { start() { events.push('start'); return true; }, frame(frame, rectangle, reanchor) {
            events.push('frame'); frames.push({ frame, rectangle, reanchor }); return true;
        }, hide() { events.push('hide'); }, close() { events.push('close'); } };
    };
    ui.terminal.write = async () => { events.push('terminal'); };
    return { ui, output, events, frames, receive: event => receive(event) };
}

test('native layout reserves a full-resolution image beside details and above status, input and IME anchor', () => {
    const renderer = new TerminalRenderer({ color: true, graphics: 'native', reducedMotion: false });
    try {
        const page = view(); const image = renderer.nativeImage(page, 91, 29);
        assert.deepEqual(image.rectangle, { column: 3, row: 3, columns: 30, rows: 17 });
        assert.equal(image.frame.width, 300); assert.equal(image.frame.height, 340);
        assert.equal(renderer.frameHeight(29, true), 29);
        assert.ok(image.rectangle.row + image.rectangle.rows <= 29 - 9);
        const rendered = renderer.render(page, 91, 29);
        assert.doesNotMatch(rendered, /\x1b_G|\x1bP/);
        assert.equal(renderer.render(page, 91, 29), '');
        assert.equal(graphicsSummary('native', true), '高清动画（原生CMD）');
        assert.equal(renderer.nativeImage(page, 40, 15), undefined);
    } finally { renderer.dispose(); }
});

test('queued native start does not advertise readiness; ready presents after terminal text and animation does not reanchor', async () => {
    const { ui, events, frames, receive } = fixture();
    try {
        ui.startNativeGraphics(); assert.equal(ui.renderer.options.graphics, 'blocks'); assert.equal(frames.length, 0);
        receive({ type: 'ready' }); await flush(ui);
        assert.equal(ui.renderer.options.graphics, 'native'); assert.equal(frames[0].reanchor, true);
        assert.equal(events[events.indexOf('frame') - 1], 'terminal');
        ui.nativeFrameKey = 'previous-animation-frame'; ui.scheduleRender(false, true); await flush(ui);
        assert.equal(frames.at(-1).reanchor, false);
        ui.menu = { title: '空闲菜单', index: 0, items: [{ label: '继续', action() {} }] };
        ui.scheduleRender(); await flush(ui); assert.equal(frames.at(-1).reanchor, true);
    } finally { await ui.finish(0); }
    assert.deepEqual(events.slice(-3), ['hide', 'close', 'terminal']);
});

test('resize and transcript scrolling hide native surface before repaint and reanchor only the new layout', async () => {
    const { ui, output, events, frames, receive } = fixture();
    try {
        ui.startNativeGraphics(); receive({ type: 'ready' }); await flush(ui);
        events.length = 0; await ui.printTranscript('只有一份正文');
        assert.equal(events[0], 'hide'); assert.equal(events[1], 'terminal'); await flush(ui);
        assert.equal(frames.at(-1).reanchor, true);
        events.length = 0; output.columns = 110; output.rows = 35; await ui.resizeTerminal(); await flush(ui);
        assert.equal(events[0], 'hide'); assert.equal(frames.at(-1).reanchor, true);
        assert.equal(frames.at(-1).rectangle.row, 8);
    } finally { await ui.finish(0); }
});

test('native unavailable restores the negotiated terminal graphics route without restarting the helper', async () => {
    const { ui, events, receive } = fixture();
    try {
        ui.startNativeGraphics(); receive({ type: 'ready' }); await flush(ui);
        ui.terminalGraphicsMode = 'sixel'; receive({ type: 'unavailable' });
        assert.equal(ui.renderer.options.graphics, 'sixel'); ui.startNativeGraphics();
        assert.equal(events.filter(event => event === 'start').length, 1);
    } finally { await ui.finish(0); }
});

test('animation queued during a terminal write keeps its non-reanchoring classification', async () => {
    const { ui, receive, frames } = fixture();
    let releaseWrite;
    try {
        ui.startNativeGraphics(); receive({ type: 'ready' }); await flush(ui);
        const revision = ui.nativeLayoutRevision;
        const pendingWrite = new Promise(resolveWrite => { releaseWrite = resolveWrite; });
        ui.terminal.write = async () => pendingWrite;
        ui.status = '动画渲染中的状态';
        ui.nativeFrameKey = 'older-animation-frame'; ui.scheduleRender(false, true);
        await delay(60); assert.equal(ui.renderInFlight, true);
        ui.scheduleRender(false, true); releaseWrite(); await flush(ui);
        assert.equal(ui.nativeLayoutRevision, revision); assert.equal(frames.at(-1).reanchor, false);
    } finally { releaseWrite?.(); await ui.finish(0); }
});

test('unchanged periodic layout updates do not reanchor a scrolled native image', async () => {
    const { ui, receive, frames } = fixture();
    try {
        ui.startNativeGraphics(); receive({ type: 'ready' }); await flush(ui);
        ui.nativeFrameKey = 'previous-image-frame';
        ui.scheduleRender(); await flush(ui);
        assert.equal(frames.at(-1).reanchor, false);
    } finally { await ui.finish(0); }
});
