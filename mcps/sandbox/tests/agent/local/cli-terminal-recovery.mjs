import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Readable, Writable } from 'node:stream';
import test from 'node:test';
import { InteractiveCli } from '../../../src/agent-cli/ui.ts';
import { terminalGraphicsHost, TerminalSession } from '../../../src/agent-cli/terminal.ts';
import { TerminalRenderer } from '../../../src/agent-cli/renderer.ts';
import { DraftBuffer } from '../../../src/agent-cli/input.ts';

const view = () => ({ inline: true, state: 'idle', status: '空闲', connection: '已连接', details: ['当前菜单'], logs: [],
    draft: new DraftBuffer(), hint: 'Enter选择', stateStartedAt: Date.now() });

test('unidentified and Conhost environments do not qualify for Kitty APC probes', () => {
    assert.deepEqual(terminalGraphicsHost({}), { kitty: false, queries: false });
    assert.equal(terminalGraphicsHost({ WT_SESSION: 'fixture-windows-terminal' }).kitty, false);
    assert.equal(terminalGraphicsHost({ TERM_PROGRAM: 'vscode', TERM: 'xterm-256color' }).kitty, false);
    assert.equal(terminalGraphicsHost({ TERM: 'xterm-kitty', KITTY_WINDOW_ID: 'fixture-window' }).kitty, true);
    assert.equal(terminalGraphicsHost({ TERM: 'xterm-kitty', TMUX: 'fixture-multiplexer' }).kitty, false);
});

test('classic host auto and explicit Kitty requests stay in block mode without sending query bytes', async () => {
    const names = ['TERM', 'TERM_PROGRAM', 'KITTY_WINDOW_ID', 'WT_SESSION', 'TMUX', 'STY'];
    const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    const output = new Writable({ write(_bytes, _encoding, done) { done(); } });
    const client = Object.assign(new EventEmitter(), { dataDir: process.cwd() });
    const ui = new InteractiveCli({ words: [], options: {} }, client,
        { stdin: Readable.from([]), stdout: output, stderr: output, cwd: process.cwd() });
    const writes = []; ui.terminal.write = async text => { writes.push(text); };
    try {
        await ui.negotiateGraphics();
        ui.initial.options.graphics = 'kitty'; await ui.negotiateGraphics();
        assert.equal(ui.renderer.options.graphics, 'blocks'); assert.equal(writes.length, 0);
        assert.equal(ui.terminal.listenerCount('reply'), 0);
    } finally {
        await ui.finish(0);
        for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
    }
});

test('changing the inline viewport origin clears its previous header before drawing the new one', () => {
    const renderer = new TerminalRenderer({ color: false, graphics: 'blocks', reducedMotion: true });
    try {
        renderer.render(view(), 91, 27);
        const resized = renderer.render(view(), 91, 29);
        assert.match(resized, /\x1b\[6;1H\x1b\[J/);
        assert.match(resized, /\x1b\[8;1H  sandbox_agent/);
        assert.doesNotMatch(resized, /\r|\n/);
        assert.equal(resized.split('sandbox_agent').length - 1, 1);
    } finally { renderer.dispose(); }
});

test('releasing the inline frame erases only its own region and leaves the shell cursor there', () => {
    const renderer = new TerminalRenderer({ color: false, graphics: 'blocks', reducedMotion: true });
    try {
        renderer.render(view(), 91, 29);
        const released = renderer.releaseFrame(29);
        assert.match(released, /\x1b\[8;1H\x1b\[J/);
        assert.match(released, /\x1b\[8;1H\x1b\[\?25h$/);
        assert.doesNotMatch(released, /\x1b\[r|sandbox_agent|\x1b\[1;1H/);
        assert.equal(renderer.releaseFrame(29), '');
    } finally { renderer.dispose(); }
});

test('terminal disposal does not home the cursor by resetting a scroll region it never changed', async () => {
    const writes = [], input = new PassThrough(); input.setRawMode = () => {};
    const output = new Writable({ write(bytes, _encoding, done) { writes.push(bytes.toString()); done(); } }); output.rows = 29;
    const terminal = new TerminalSession(input, output);
    await terminal.open(); await terminal.dispose();
    const restored = writes.at(-1);
    assert.match(restored, /\x1b\[\?2004l/); assert.match(restored, /\x1b\[\?25h\r\n$/);
    assert.doesNotMatch(restored, /\x1b\[r|\x1b\[H|\x1b\[1;1H/);
});
